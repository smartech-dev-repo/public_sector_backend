import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan origination (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-ORIGIN-${Date.now()}`;
  const agency = 'NPF';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    adminAccessToken = loginRes.body.accessToken;

    await prisma.loanTermOption.create({
      data: {
        agency,
        tenorMonths: 3,
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });
  });

  afterAll(async () => {
    // Note: clientLoan/ippisRecord rows are created with `${staffId}-${suffix}`
    // (see createVerifiedClient below), so an exact-match `staffId` filter here
    // would delete nothing and leave the ClientLoan FK-referencing its
    // LoanRequest when the next line runs — hence `startsWith`.
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: { contains: 'E2E Origination' } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234804' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 3 } });
    await app.close();
  });

  async function createVerifiedClient(phoneSuffix: string, staffIdSuffix: string) {
    const phone = `+234804${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E Origination Test', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Origination Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });
    return { client, accessToken };
  }

  it('lists the active loan terms for the client\'s own agency', async () => {
    const { accessToken } = await createVerifiedClient('0000001', 'A');

    const res = await request(app.getHttpServer())
      .get('/client/loan-terms')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].tenorMonths).toBe(3);
  });

  it(
    'runs the full manual-review flow: request -> confirm -> admin approve -> admin disburse -> ClientLoan exists',
    async () => {
      const { client, accessToken } = await createVerifiedClient('0000002', 'B');

      const createRes = await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 200000, tenorMonths: 3 })
        .expect(201);
      const loanRequestId = createRes.body.id;

      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: client.phone, message: 'YES' })
        .expect(200);

      const listRes = await request(app.getHttpServer())
        .get('/admin/loan-requests?status=CONFIRMED')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(listRes.body.some((lr: { id: string }) => lr.id === loanRequestId)).toBe(true);

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('APPROVED'));

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${loanRequestId}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200)
        .expect((res) => expect(res.body.status).toBe('DISBURSED'));

      const clientLoan = await prisma.clientLoan.findUnique({ where: { loanRequestId } });
      expect(clientLoan).not.toBeNull();
      expect(Number(clientLoan!.disbursedAmount)).toBe(196000);

      await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 10000, tenorMonths: 3 })
        .expect(422);
    },
    30000,
  );

  it('rejects a CONFIRMED request with a reason', async () => {
    const { client, accessToken } = await createVerifiedClient('0000003', 'C');

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 150000, tenorMonths: 3 })
      .expect(201);
    const loanRequestId = createRes.body.id;

    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone: client.phone, message: 'YES' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/reject`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ reason: 'Insufficient documentation' })
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('REJECTED');
        expect(res.body.rejectionReason).toBe('Insufficient documentation');
      });
  });

  it('returns a CSV for the disbursement summary export', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const res = await request(app.getHttpServer())
      .get(`/admin/client-loans/disbursement-summary?month=${month}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('clientPhone,clientName,agency,principalAmount');
  });
});

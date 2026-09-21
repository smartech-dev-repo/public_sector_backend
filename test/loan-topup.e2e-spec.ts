import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan topup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-TOPUP-${Date.now()}`;
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
        tenorMonths: 4,
        interestRatePercent: 6,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 1,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Topup Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E Topup Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234805' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 4 } });
    await app.close();
  });

  async function createVerifiedClient(phoneSuffix: string, staffIdSuffix: string) {
    const phone = `+234805${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E Topup Test', salary: 2000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Topup Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });
    return { client, accessToken };
  }

  async function originateAndDisburseLoan(phoneSuffix: string, staffIdSuffix: string) {
    const { client, accessToken } = await createVerifiedClient(phoneSuffix, staffIdSuffix);

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 100000, tenorMonths: 4 })
      .expect(201);
    const loanRequestId = createRes.body.id;

    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone: client.phone, message: 'YES' })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${loanRequestId}/disburse`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    return { client, accessToken };
  }

  it(
    'runs a full topup flow: existing active loan -> topup request -> confirm -> admin approve/disburse -> ClientLoan updated',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000001', 'A');
      const before = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-A` } });

      const topupRes = await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 20000, tenorMonths: 4 })
        .expect(201);
      const topupId = topupRes.body.id;
      expect(topupRes.body.type).toBe('TOPUP');

      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: client.phone, message: 'YES' })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${topupId}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      const after = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-A` } });
      expect(Number(after!.principalAmount)).toBe(Number(before!.principalAmount) + 20000);
      expect(Number(after!.principalBalance)).toBe(Number(before!.principalBalance) + 20000);

      const secondLoanCount = await prisma.clientLoan.count({ where: { agency, staffId: `${staffId}-A` } });
      expect(secondLoanCount).toBe(1);
    },
    30000,
  );

  it(
    'rejects a second topup while the first is still in progress',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000002', 'B');

      await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 10000, tenorMonths: 4 })
        .expect(201);

      await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 5000, tenorMonths: 4 })
        .expect(422);
    },
    30000,
  );

  it('rejects a topup when the client has no active loan', async () => {
    const { accessToken } = await createVerifiedClient('0000003', 'C');

    await request(app.getHttpServer())
      .post('/client/loan-requests/topup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 10000, tenorMonths: 4 })
      .expect(422);
  });
});

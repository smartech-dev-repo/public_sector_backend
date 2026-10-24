import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan topup/renewal (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-TOPUP-${Date.now()}`;
  const agency = 'NPF';
  const productCode = `E2E-TOPUP-PRODUCT-${Date.now()}`;

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

    await prisma.loanProduct.create({
      data: {
        productName: 'E2E Topup Product',
        productCode,
        sectors: [agency],
        minimumAmount: 1000,
        maximumAmount: 1000000,
        minimumTenorMonths: 4,
        maximumTenorMonths: 4,
        interestTiers: [{ minTenorMonths: 4, maxTenorMonths: 4, interestRatePercent: 6 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 1,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientLoanRepaymentVariance.deleteMany({ where: { clientLoan: { agency, staffId: { startsWith: staffId } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { ippisRecord: { staffId: { startsWith: staffId } } } } } });
    const clientIds = (
      await prisma.clientOnboarding.findMany({
        where: { ippisRecord: { staffId: { startsWith: staffId } } },
        select: { clientId: true },
      })
    ).map((c) => c.clientId);
    await prisma.walletEntry.deleteMany({ where: { clientId: { in: clientIds } } });
    await prisma.clientOnboarding.deleteMany({ where: { ippisRecord: { staffId: { startsWith: staffId } } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
    await prisma.loanProduct.deleteMany({ where: { productCode } });
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

    return { client, accessToken };
  }

  async function closeLoanBalance(clientId: string, accessToken: string, agencyStaffId: string) {
    const loan = await prisma.clientLoan.findFirst({ where: { agency, staffId: agencyStaffId } });
    const balance = Number(loan!.principalBalance);
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: balance, description: 'E2E test credit' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/client/client-loans/me/apply-wallet')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: balance })
      .expect(200);
  }

  it(
    'rejects a renewal while the existing loan still has an outstanding balance',
    async () => {
      const { accessToken } = await originateAndDisburseLoan('0000001', 'A');

      await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 20000, tenorMonths: 4 })
        .expect(422)
        .expect((res) => expect(res.body.message).toMatch(/outstanding balance/));
    },
    30000,
  );

  it(
    'runs a full renewal flow once the balance reaches 0: request -> confirm -> admin approve -> admin disburse -> ClientLoan reset in place',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000002', 'B');
      await closeLoanBalance(client.id, accessToken, `${staffId}-B`);

      const beforeClosed = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-B` } });
      expect(Number(beforeClosed!.principalBalance)).toBe(0);
      expect(beforeClosed!.status).toBe('CLOSED');

      const topupRes = await request(app.getHttpServer())
        .post('/client/loan-requests/topup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 50000, tenorMonths: 4 })
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

      const after = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-B` } });
      expect(Number(after!.principalAmount)).toBe(50000);
      expect(Number(after!.principalBalance)).toBe(50000);
      expect(after!.status).toBe('ACTIVE');

      const rowCount = await prisma.clientLoan.count({ where: { agency, staffId: `${staffId}-B` } });
      expect(rowCount).toBe(1);
    },
    30000,
  );

  it(
    'rejects a second renewal request while the first is still in progress',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000003', 'C');
      await closeLoanBalance(client.id, accessToken, `${staffId}-C`);

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

  it('rejects a renewal when the client has never had a loan at all', async () => {
    const { accessToken } = await createVerifiedClient('0000004', 'D');

    await request(app.getHttpServer())
      .post('/client/loan-requests/topup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 10000, tenorMonths: 4 })
      .expect(422)
      .expect((res) => expect(res.body.message).toMatch(/no existing loan to renew/));
  });
});

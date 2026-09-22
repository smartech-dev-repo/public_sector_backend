import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Spend wallet balance toward a loan payment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-WALLETPAY-${Date.now()}`;
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
        tenorMonths: 2,
        interestRatePercent: 0,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 0,
        managementChargeApplication: 'ADD_TO_REPAYMENT',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientLoanRepaymentVariance.deleteMany({ where: { clientLoan: { agency, staffId: { startsWith: staffId } } } });
    await prisma.walletEntry.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E WalletPay Test' } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E WalletPay Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E WalletPay Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234807' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
    await app.close();
  });

  async function originateAndDisburseLoan(phoneSuffix: string, staffIdSuffix: string) {
    const phone = `+234807${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E WalletPay Test', salary: 5000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E WalletPay Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 90000, tenorMonths: 2 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone, message: 'YES' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${createRes.body.id}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/admin/loan-requests/${createRes.body.id}/disburse`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    return { client, accessToken };
  }

  it(
    'lets a client apply their wallet balance toward their loan, reducing the balance and appearing in the schedule',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000001', 'A');

      await request(app.getHttpServer())
        .post(`/admin/clients/${client.id}/wallet/credit`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ amount: 30000, description: 'E2E test credit' })
        .expect(200);

      const applyRes = await request(app.getHttpServer())
        .post('/client/client-loans/me/apply-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 20000 })
        .expect(200);
      expect(applyRes.body).toEqual({ appliedAmount: 20000, remainingBalance: 70000, status: 'DEFAULT' });

      const walletRes = await request(app.getHttpServer())
        .get('/client/wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(walletRes.body.balance).toBe(10000);

      const myLoanRes = await request(app.getHttpServer())
        .get('/client/client-loans/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const currentPeriodEntry = myLoanRes.body.schedule.find(
        (row: { status: string }) => row.status !== 'UPCOMING',
      );
      expect(currentPeriodEntry).toEqual(
        expect.objectContaining({ actualAmount: 20000, status: 'UNDER_PAID' }),
      );
    },
    30000,
  );

  it(
    'rejects a second wallet application in the same period with a 409',
    async () => {
      const { client, accessToken } = await originateAndDisburseLoan('0000002', 'B');

      await request(app.getHttpServer())
        .post(`/admin/clients/${client.id}/wallet/credit`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .send({ amount: 30000, description: 'E2E test credit' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/client/client-loans/me/apply-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 10000 })
        .expect(200);

      await request(app.getHttpServer())
        .post('/client/client-loans/me/apply-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 5000 })
        .expect(409);
    },
    30000,
  );

  it(
    'rejects an application exceeding the wallet balance with a 422',
    async () => {
      const { accessToken } = await originateAndDisburseLoan('0000003', 'C');

      await request(app.getHttpServer())
        .post('/client/client-loans/me/apply-wallet')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ amount: 5000 })
        .expect(422);
    },
    30000,
  );
});

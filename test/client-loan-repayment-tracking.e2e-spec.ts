import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { ClientLoanReconciliationService } from '../src/reconciliation/client-loan-reconciliation.service';

describe('Client loan repayment tracking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-REPAY-${Date.now()}`;
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
    await prisma.walletEntry.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Repay Test' } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Repay Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E Repay Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234806' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
    await app.close();
  });

  async function originateAndDisburseLoan(phoneSuffix: string, staffIdSuffix: string, amount: number) {
    const phone = `+234806${phoneSuffix}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId: `${staffId}-${staffIdSuffix}`, employeeName: 'E2E Repay Test', salary: 5000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: client.id,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Repay Test',
        agency,
        step: 'COMPLETED',
      },
    });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount, tenorMonths: 2 })
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

    const clientLoan = await prisma.clientLoan.findFirst({ where: { agency, staffId: `${staffId}-${staffIdSuffix}` } });
    return { client, accessToken, clientLoan: clientLoan! };
  }

  it(
    'reconciles a matched, an underpaid, and an overpaid loan, updating balance/status and crediting the wallet on overpayment',
    async () => {
      const matched = await originateAndDisburseLoan('0000001', 'A', 90000);
      const underpaid = await originateAndDisburseLoan('0000002', 'B', 90000);
      const overpaid = await originateAndDisburseLoan('0000003', 'C', 90000);

      // Matches toPeriodKey()'s own local-time-based format exactly (src/reconciliation/period.util.ts) —
      // deriving this via toISOString() would risk a UTC/local mismatch near a month boundary.
      const disbursedAt = matched.clientLoan.disbursementDate;
      const period = `${disbursedAt.getFullYear()}-${String(disbursedAt.getMonth() + 1).padStart(2, '0')}`;
      await prisma.loanRepaymentRecord.createMany({
        data: [
          { agency, staffId: `${staffId}-A`, period, elementName: 'Principal', amount: 45000 },
          { agency, staffId: `${staffId}-B`, period, elementName: 'Principal', amount: 20000 },
          { agency, staffId: `${staffId}-C`, period, elementName: 'Principal', amount: 50000 },
        ],
      });

      const clientLoanReconciliationService = (app as unknown as { get: (t: unknown) => ClientLoanReconciliationService }).get(
        ClientLoanReconciliationService,
      );
      await clientLoanReconciliationService.reconcileAll();

      const matchedLoan = await prisma.clientLoan.findUnique({ where: { id: matched.clientLoan.id } });
      expect(Number(matchedLoan!.principalBalance)).toBe(45000);
      expect(matchedLoan!.status).toBe('ACTIVE');

      const underpaidLoan = await prisma.clientLoan.findUnique({ where: { id: underpaid.clientLoan.id } });
      expect(Number(underpaidLoan!.principalBalance)).toBe(70000);
      expect(underpaidLoan!.status).toBe('DEFAULT');

      const overpaidLoan = await prisma.clientLoan.findUnique({ where: { id: overpaid.clientLoan.id } });
      expect(Number(overpaidLoan!.principalBalance)).toBe(45000);
      expect(overpaidLoan!.status).toBe('ACTIVE');

      const overpaidWallet = await request(app.getHttpServer())
        .get('/client/wallet')
        .set('Authorization', `Bearer ${overpaid.accessToken}`)
        .expect(200);
      expect(overpaidWallet.body.balance).toBe(5000);

      const myLoanRes = await request(app.getHttpServer())
        .get('/client/client-loans/me')
        .set('Authorization', `Bearer ${matched.accessToken}`)
        .expect(200);
      expect(myLoanRes.body.id).toBe(matched.clientLoan.id);
      expect(myLoanRes.body.schedule[0]).toEqual(
        expect.objectContaining({ period, actualAmount: 45000, status: 'MATCHED' }),
      );

      const adminPlanRes = await request(app.getHttpServer())
        .get(`/admin/client-loans/${matched.clientLoan.id}/repayment-plan`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(adminPlanRes.body.id).toBe(matched.clientLoan.id);
    },
    30000,
  );

  it('returns null for a client with no ClientLoan', async () => {
    const phone = `+234806${'0000004'}`;
    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
    const accessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });

    const res = await request(app.getHttpServer())
      .get('/client/client-loans/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    // Nest's RouterResponseController sends a bodyless response when a handler
    // returns null/undefined (`isNil(result)` -> `response.status(code).send()`,
    // no JSON serialization) rather than the literal string "null" — confirmed by
    // running this test, which showed no content-type/content-length on the
    // response. supertest parses that empty body as `{}`, not `null`.
    expect(res.body).toEqual({});

    await prisma.client.deleteMany({ where: { id: client.id } });
  });
});

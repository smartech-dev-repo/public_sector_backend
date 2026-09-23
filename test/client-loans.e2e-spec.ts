import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Client loan dashboard (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let accessToken: string;
  let activeLoanId: string;
  let defaultLoanId: string;
  const phone = `+234803${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-LOANS-${Date.now()}`;
  const agency = 'NPF';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency, staffId, employeeName: 'E2E Loans Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Loans Test',
        agency,
        bvn: '11111111111',
        step: 'COMPLETED',
      },
    });

    const activeLoan = await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST`,
        customerName: 'E2E Loans Test',
        accountNumber: '0000000000',
        ippisNumber: staffId,
        agency,
        loanAmount: 500000,
        principalBalance: 400000,
        disbursementDate: new Date('2025-01-01'),
        maturationDate: new Date('2099-01-01'),
        product: 'Salary Advance',
        interestRatePercent: 5,
        bvn: '11111111111',
      },
    });
    activeLoanId = activeLoan.id;

    const defaultLoan = await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST-DEFAULT`,
        customerName: 'E2E Loans Test',
        accountNumber: '0000000002',
        ippisNumber: staffId,
        agency,
        loanAmount: 200000,
        principalBalance: 150000,
        disbursementDate: new Date('2025-01-01'),
        maturationDate: new Date('2025-06-01'),
        product: 'Emergency Loan',
        interestRatePercent: 5,
        bvn: '11111111111',
      },
    });
    defaultLoanId = defaultLoan.id;

    await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST-MISMATCH`,
        customerName: 'Someone Else',
        accountNumber: '0000000001',
        ippisNumber: staffId,
        agency,
        loanAmount: 100000,
        principalBalance: 100000,
        disbursementDate: new Date('2025-02-01'),
        maturationDate: new Date('2026-02-01'),
        product: 'Salary Advance',
        interestRatePercent: 5,
        bvn: '99999999999',
      },
    });
    await prisma.loanRepaymentRecord.create({
      data: { agency, staffId, period: '2025-01', elementName: 'Principal', amount: 50000 },
    });
    await prisma.repaymentVariance.create({
      data: {
        loanId: activeLoanId,
        period: '2025-01',
        expectedAmount: 45000,
        actualAmount: 45000,
        variance: 0,
        status: 'MATCHED',
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.repaymentVariance.deleteMany({ where: { loanId: { in: [activeLoanId, defaultLoanId] } } });
    await prisma.loanRepaymentRecord.deleteMany({ where: { agency, staffId } });
    await prisma.loan.deleteMany({ where: { ippisNumber: staffId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('returns matched loans with a computed status, excluding the bvn-mismatched one, plus matched repayments', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans.data).toHaveLength(2);
    const active = res.body.loans.data.find((loan: { id: string }) => loan.id === activeLoanId);
    const defaulted = res.body.loans.data.find((loan: { id: string }) => loan.id === defaultLoanId);
    expect(active.status).toBe('ACTIVE');
    expect(defaulted.status).toBe('DEFAULT');
    expect(res.body.repayments).toHaveLength(1);
    expect(res.body.repayments[0].elementName).toBe('Principal');
  });

  it('filters the loan list by status', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans?status=DEFAULT')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans.data).toHaveLength(1);
    expect(res.body.loans.data[0].id).toBe(defaultLoanId);
  });

  it('paginates the loans list', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans?page=1&limit=1')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans.data).toHaveLength(1);
    expect(res.body.loans.meta).toEqual({ total: 2, page: 1, limit: 1, totalPages: 2 });
  });

  it('filters the loan list by product', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans?product=Emergency Loan')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans.data).toHaveLength(1);
    expect(res.body.loans.data[0].id).toBe(defaultLoanId);
  });

  it('rejects an invalid status filter with a 400', async () => {
    await request(app.getHttpServer())
      .get('/client/loans?status=NOT_A_STATUS')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('returns a full repayment plan with UPCOMING periods for a loan with a real disbursement/maturity window', async () => {
    const res = await request(app.getHttpServer())
      .get(`/client/loans/${activeLoanId}/repayment-plan`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loanId).toBe(activeLoanId);
    expect(res.body.schedule.length).toBeGreaterThan(1);
    expect(res.body.schedule[0]).toEqual(
      expect.objectContaining({ period: '2025-01', actualAmount: 45000, status: 'MATCHED' }),
    );
    const laterPeriod = res.body.schedule[res.body.schedule.length - 1];
    expect(laterPeriod.status).toBe('UPCOMING');
    expect(laterPeriod.actualAmount).toBeNull();
  });

  it('returns 404 for a repayment plan on someone else\'s loan', async () => {
    const otherLoan = await prisma.loan.findFirst({ where: { customerId: `${staffId}-CUST-MISMATCH` } });

    await request(app.getHttpServer())
      .get(`/client/loans/${otherLoan!.id}/repayment-plan`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });

  it('returns 404 for a repayment plan on a nonexistent loan', async () => {
    await request(app.getHttpServer())
      .get('/client/loans/00000000-0000-0000-0000-000000000000/repayment-plan')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });
});

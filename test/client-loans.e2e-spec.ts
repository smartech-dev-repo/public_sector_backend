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

    await prisma.loan.create({
      data: {
        customerId: `${staffId}-CUST`,
        customerName: 'E2E Loans Test',
        accountNumber: '0000000000',
        ippisNumber: staffId,
        agency,
        loanAmount: 500000,
        principalBalance: 400000,
        disbursementDate: new Date('2025-01-01'),
        maturationDate: new Date('2026-01-01'),
        product: 'Salary Advance',
        interestRatePercent: 5,
        bvn: '11111111111',
      },
    });
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

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.loanRepaymentRecord.deleteMany({ where: { agency, staffId } });
    await prisma.loan.deleteMany({ where: { ippisNumber: staffId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('returns matched loans, excluding the bvn-mismatched one, plus matched repayments', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/loans')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0].customerId).toBe(`${staffId}-CUST`);
    expect(res.body.repayments).toHaveLength(1);
    expect(res.body.repayments[0].elementName).toBe('Principal');
  });
});

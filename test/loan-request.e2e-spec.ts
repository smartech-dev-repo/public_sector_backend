import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Loan request workflow (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let accessToken: string;
  const phone = `+234802${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-LOAN-${Date.now()}`;

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
      data: { agency: 'NPF', staffId, employeeName: 'E2E Loan Test', salary: 1000000 },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Loan Test',
        agency: 'NPF',
        step: 'COMPLETED',
      },
    });

    await prisma.loanTermOption.create({
      data: {
        agency: 'NPF',
        tenorMonths: 6,
        interestRatePercent: 5,
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.loanRequest.deleteMany({ where: { clientId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.loanTermOption.deleteMany({ where: { agency: 'NPF', tenorMonths: 6 } });
    await app.close();
  });

  let loanRequestId: string;

  it('rejects a request that exceeds the salary cap', async () => {
    await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 100000000, tenorMonths: 6 })
      .expect(422);
  });

  it('creates a loan request and resends the confirmation while still PENDING', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amount: 500000, tenorMonths: 6 })
      .expect(201);
    expect(createRes.body.status).toBe('PENDING');
    loanRequestId = createRes.body.id;

    const resendRes = await request(app.getHttpServer())
      .post(`/client/loan-requests/${loanRequestId}/resend`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(resendRes.body.status).toBe('PENDING');
  });

  it('confirms the request via the inbound webhook and lists it as CONFIRMED', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/sms/inbound')
      .send({ phone, message: 'YES' })
      .expect(200);

    const listRes = await request(app.getHttpServer())
      .get('/client/loan-requests')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const confirmed = listRes.body.find((lr: { id: string }) => lr.id === loanRequestId);
    expect(confirmed.status).toBe('CONFIRMED');
  });

  it('rejects resend once the request is no longer PENDING', async () => {
    await request(app.getHttpServer())
      .post(`/client/loan-requests/${loanRequestId}/resend`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });
});

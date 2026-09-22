import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin client visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const staffId = `E2E-VISIBILITY-${Date.now()}`;
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
    await prisma.walletEntry.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Visibility Test' } } } });
    await prisma.clientLoan.deleteMany({ where: { agency, staffId: { startsWith: staffId } } });
    await prisma.loanRequest.deleteMany({ where: { client: { onboarding: { agency, employeeName: 'E2E Visibility Test' } } } });
    await prisma.clientOnboarding.deleteMany({ where: { agency, employeeName: 'E2E Visibility Test' } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { startsWith: staffId } } });
    await prisma.client.deleteMany({ where: { phone: { startsWith: '+234808' } } });
    await prisma.loanTermOption.deleteMany({ where: { agency, tenorMonths: 2 } });
    await app.close();
  });

  it(
    'lists a client\'s loan requests and loans scoped by clientId, excluding other clients, and returns a merged activity timeline',
    async () => {
      const phoneA = '+2348080000001';
      const clientA = await prisma.client.create({ data: { phone: phoneA, status: 'VERIFIED' } });
      const ippisA = await prisma.ippisRecord.create({
        data: { agency, staffId: `${staffId}-A`, employeeName: 'E2E Visibility Test', salary: 5000000 },
      });
      await prisma.clientOnboarding.create({
        data: {
          clientId: clientA.id,
          ippisRecordId: ippisA.id,
          employeeName: 'E2E Visibility Test',
          agency,
          step: 'COMPLETED',
        },
      });
      const tokenService = (app as unknown as { get: (t: unknown) => TokenService }).get(TokenService);
      const accessTokenA = tokenService.signAccessToken({ sub: clientA.id, type: 'client' });

      const phoneB = '+2348080000002';
      const clientB = await prisma.client.create({ data: { phone: phoneB, status: 'VERIFIED' } });
      const ippisB = await prisma.ippisRecord.create({
        data: { agency, staffId: `${staffId}-B`, employeeName: 'E2E Visibility Test', salary: 5000000 },
      });
      await prisma.clientOnboarding.create({
        data: {
          clientId: clientB.id,
          ippisRecordId: ippisB.id,
          employeeName: 'E2E Visibility Test',
          agency,
          step: 'COMPLETED',
        },
      });
      const accessTokenB = tokenService.signAccessToken({ sub: clientB.id, type: 'client' });

      const createResA = await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessTokenA}`)
        .send({ amount: 90000, tenorMonths: 2 })
        .expect(201);
      await request(app.getHttpServer())
        .post('/webhooks/sms/inbound')
        .send({ phone: phoneA, message: 'YES' })
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${createResA.body.id}/approve`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      await request(app.getHttpServer())
        .post(`/admin/loan-requests/${createResA.body.id}/disburse`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .post('/client/loan-requests')
        .set('Authorization', `Bearer ${accessTokenB}`)
        .send({ amount: 50000, tenorMonths: 2 })
        .expect(201);

      const loanRequestsRes = await request(app.getHttpServer())
        .get(`/admin/loan-requests?clientId=${clientA.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(loanRequestsRes.body).toHaveLength(1);
      expect(loanRequestsRes.body[0].clientId).toBe(clientA.id);

      const loansRes = await request(app.getHttpServer())
        .get(`/admin/client-loans?clientId=${clientA.id}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      expect(loansRes.body).toHaveLength(1);
      expect(loansRes.body[0].clientId).toBe(clientA.id);

      await request(app.getHttpServer())
        .get('/admin/client-loans')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(400);

      const activitiesRes = await request(app.getHttpServer())
        .get(`/admin/clients/${clientA.id}/activities`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(200);
      const types = activitiesRes.body.map((entry: { type: string }) => entry.type);
      expect(types).toContain('loan-request.created');
      expect(types).toContain('loan-request.confirmed');
      expect(types).toContain('loan-request.approve');
      expect(types).toContain('loan-request.disburse');
      expect(types).toContain('onboarding.step');
      const timestamps = activitiesRes.body.map((entry: { timestamp: string }) => new Date(entry.timestamp).getTime());
      const sorted = [...timestamps].sort((a, b) => b - a);
      expect(timestamps).toEqual(sorted);

      await request(app.getHttpServer())
        .get('/admin/clients/00000000-0000-0000-0000-000000000000/activities')
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .expect(404);
    },
    30000,
  );
});

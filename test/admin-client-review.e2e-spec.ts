import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin client review (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let clientId: string;
  const phone = `+234801${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-REVIEW-${Date.now()}`;
  let agentOnboardedClientId: string;
  let throwawayAgentId: string;
  const agentOnboardedPhone = `+234802${Date.now().toString().slice(-7)}`;
  const agentStaffId = `E2E-AGENT-FILTER-${Date.now()}`;

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

    const client = await prisma.client.create({ data: { phone, email: `e2e-review-${Date.now()}@example.com` } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'E2E Review Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Review Test',
        agency: 'NPF',
        bvn: '12345678901',
        nin: '98765432109',
        bvnSelfie: 'client-onboarding/x/bvn-selfie.jpg',
        ninSelfie: 'client-onboarding/x/nin-selfie.jpg',
        identityVerified: true,
        liveSelfieKey: 'client-onboarding/x/live-selfie.jpg',
        faceMatchBvnScore: 0.95,
        faceMatchNinScore: 0.2,
        faceMatchPassed: false,
        step: 'FACE_MATCH_PENDING',
        failureReasons: { identityVerified: true, faceMatchPassed: false },
      },
    });
    await prisma.client.update({ where: { id: clientId }, data: { status: 'MANUAL_REVIEW' } });

    const throwawayAgent = await prisma.agent.create({
      data: {
        email: `e2e-agent-filter-${Date.now()}@example.com`,
        phone: '+2348099999999',
        fullName: 'E2E Agent Filter Test',
        address: '1 St',
        cvKey: '',
        status: 'APPROVED',
      },
    });
    throwawayAgentId = throwawayAgent.id;

    const agentOnboardedClient = await prisma.client.create({
      data: { phone: agentOnboardedPhone, email: `e2e-agent-filter-client-${Date.now()}@example.com` },
    });
    agentOnboardedClientId = agentOnboardedClient.id;
    const agentIppisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId: agentStaffId, employeeName: 'E2E Agent Filter Test Client' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId: agentOnboardedClientId,
        ippisRecordId: agentIppisRecord.id,
        employeeName: 'E2E Agent Filter Test Client',
        agency: 'NPF',
        onboardedByAgentId: throwawayAgentId,
        step: 'COMPLETED',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: agentOnboardedClientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: agentStaffId } });
    await prisma.client.deleteMany({ where: { id: agentOnboardedClientId } });
    await prisma.agent.deleteMany({ where: { id: throwawayAgentId } });
    await app.close();
  });

  it('rejects an unauthenticated request', () => {
    return request(app.getHttpServer()).get('/admin/clients').expect(401);
  });

  it('lists clients filtered by MANUAL_REVIEW status', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ status: 'MANUAL_REVIEW' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((c: { id: string }) => c.id === clientId)).toBe(true);

    const row = res.body.data.find((c: { id: string }) => c.id === clientId);
    expect(typeof row.onboarding.bvnSelfieUrl).toBe('string');
    expect(row.onboarding.bvnSelfieUrl.length).toBeGreaterThan(0);
    expect(typeof row.onboarding.liveSelfieUrl).toBe('string');
    expect(row.onboarding).not.toHaveProperty('bvnSelfie');
    expect(row.onboarding).not.toHaveProperty('ninSelfie');
    expect(row.onboarding).not.toHaveProperty('liveSelfieKey');

    expect(row.loanSummary).toEqual({
      hasLoan: false,
      source: null,
      status: null,
      principal: null,
      balance: null,
      monthlyRepayment: null,
      nextPaymentDate: null,
      tenorMonths: null,
      interestRatePercent: null,
    });
    expect(row.topupEligibility.eligible).toBe(false);
  });

  it('gets the full client detail including onboarding', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.onboarding.faceMatchPassed).toBe(false);
    expect(typeof res.body.onboarding.bvnSelfieUrl).toBe('string');
    expect(res.body.onboarding.bvnSelfieUrl.length).toBeGreaterThan(0);
    expect(typeof res.body.onboarding.ninSelfieUrl).toBe('string');
    expect(res.body.onboarding.ninSelfieUrl.length).toBeGreaterThan(0);
    expect(typeof res.body.onboarding.liveSelfieUrl).toBe('string');
    expect(res.body.onboarding.liveSelfieUrl.length).toBeGreaterThan(0);
    expect(res.body.onboarding).not.toHaveProperty('bvnSelfie');
    expect(res.body.onboarding).not.toHaveProperty('ninSelfie');
    expect(res.body.onboarding).not.toHaveProperty('liveSelfieKey');

    expect(res.body.loanSummary.hasLoan).toBe(false);
    expect(res.body).toHaveProperty('topupEligibility');
    expect(res.body).toHaveProperty('loanSchedule', null);
  });

  it('returns onboardingSource on the list and detail views', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ status: 'MANUAL_REVIEW' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    const row = listRes.body.data.find((c: { id: string }) => c.id === clientId);
    expect(row.onboardingSource).toBe('SELF');

    const detailRes = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(detailRes.body.onboardingSource).toBe('SELF');
  });

  it('filters the list by onboardingSource', async () => {
    const selfRes = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ onboardingSource: 'SELF' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(selfRes.body.data.some((c: { id: string }) => c.id === clientId)).toBe(true);

    const agentRes = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ onboardingSource: 'AGENT' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(agentRes.body.data.some((c: { id: string }) => c.id === clientId)).toBe(false);
  });

  it('filters the list by agentId', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ agentId: throwawayAgentId })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.data.every((c: { id: string }) => c.id === agentOnboardedClientId)).toBe(true);
    expect(res.body.data.some((c: { id: string }) => c.id === agentOnboardedClientId)).toBe(true);
  });

  it('returns an analytics summary with totals and breakdowns', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients/analytics')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.totalClients).toBeGreaterThanOrEqual(1);
    expect(res.body.bySource).toEqual(
      expect.objectContaining({
        SELF: expect.any(Number),
        AGENT: expect.any(Number),
        ADMIN: expect.any(Number),
        NONE: expect.any(Number),
      }),
    );
    expect(Object.keys(res.body.byOnboardingStep).sort()).toEqual(
      ['COMPLETED', 'DOCUMENTS_SUBMITTED', 'FACE_MATCH_PENDING', 'IDENTITY_SUBMITTED', 'IPPIS_LINKED', 'PHONE_VERIFIED'].sort(),
    );
    expect(Object.keys(res.body.byClientStatus).sort()).toEqual(
      ['MANUAL_REVIEW', 'PENDING_IPPIS', 'PHONE_VERIFIED', 'VERIFIED'].sort(),
    );
    expect(Array.isArray(res.body.agentLeaderboard)).toBe(true);
    expect(res.body.activity).toEqual(
      expect.objectContaining({
        clientsWithAtLeastOneLoanRequest: expect.any(Number),
        clientsWithAtLeastOneDisbursedLoan: expect.any(Number),
        clientsWithAtLeastOneSession: expect.any(Number),
        totalLoanRequests: expect.any(Number),
        totalWalletEntries: expect.any(Number),
      }),
    );
  });

  it('retries: resets to IDENTITY_SUBMITTED since only the face match failed', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/retry`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ note: 'blurry selfie, please retake' })
      .expect(200);
    expect(res.body.status).toBe('PENDING_IPPIS');

    const onboarding = await prisma.clientOnboarding.findUnique({ where: { clientId } });
    expect(onboarding!.step).toBe('IDENTITY_SUBMITTED');
    expect(onboarding!.bvn).toBe('12345678901');
    expect(onboarding!.liveSelfieKey).toBeNull();
  });

  it('rejects approve/retry once the client is no longer in MANUAL_REVIEW', () => {
    return request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);
  });
});

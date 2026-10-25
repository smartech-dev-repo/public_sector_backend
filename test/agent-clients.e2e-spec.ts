// test/agent-clients.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Agent own-clients list (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  const createdClientIds: string[] = [];
  const createdStaffIds: string[] = [];
  const createdAgentIds: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);
  });

  afterAll(async () => {
    await prisma.loanRequest.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: createdStaffIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it("only returns clients this agent onboarded, not another agent's", async () => {
    const agentA = await prisma.agent.create({
      data: {
        email: `agent-a-${Date.now()}@example.com`,
        phone: '+2348012340002',
        fullName: 'Agent A',
        address: '1 St',
        status: 'APPROVED',
        cvKey: 'agents/e2e/a.pdf',
        canOnboardClients: true,
      },
    });
    createdAgentIds.push(agentA.id);
    const agentB = await prisma.agent.create({
      data: {
        email: `agent-b-${Date.now()}@example.com`,
        phone: '+2348012340003',
        fullName: 'Agent B',
        address: '1 St',
        status: 'APPROVED',
        cvKey: 'agents/e2e/b.pdf',
        canOnboardClients: true,
      },
    });
    createdAgentIds.push(agentB.id);
    const agentAToken = tokenService.signAccessToken({ sub: agentA.id, type: 'agent', canOnboardClients: true });
    const agentBToken = tokenService.signAccessToken({ sub: agentB.id, type: 'agent', canOnboardClients: true });

    const staffIdA = `E2E-MYCLIENTS-A-${Date.now()}`;
    const staffIdB = `E2E-MYCLIENTS-B-${Date.now()}`;
    createdStaffIds.push(staffIdA, staffIdB);
    await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId: staffIdA, employeeName: 'Client Of A', phone: `+234812${Date.now().toString().slice(-7)}` },
    });
    await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId: staffIdB, employeeName: 'Client Of B', phone: `+234813${Date.now().toString().slice(-7)}` },
    });

    const resA = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${agentAToken}`)
      .send({ ippisNumber: staffIdA })
      .expect(201);
    createdClientIds.push(resA.body.clientId);

    await request(app.getHttpServer())
      .post(`/agent/clients/${resA.body.clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${agentAToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201);

    const resB = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${agentBToken}`)
      .send({ ippisNumber: staffIdB })
      .expect(201);
    createdClientIds.push(resB.body.clientId);

    const listRes = await request(app.getHttpServer())
      .get('/agent/clients')
      .set('Authorization', `Bearer ${agentAToken}`)
      .expect(200);

    const ids = listRes.body.data.map((c: { id: string }) => c.id);
    expect(ids).toContain(resA.body.clientId);
    expect(ids).not.toContain(resB.body.clientId);

    const rowA = listRes.body.data.find((c: { id: string }) => c.id === resA.body.clientId);
    expect(typeof rowA.onboarding.bvnSelfieUrl).toBe('string');
    expect(rowA.onboarding.bvnSelfieUrl.length).toBeGreaterThan(0);
    expect(typeof rowA.onboarding.ninSelfieUrl).toBe('string');
    expect(rowA.onboarding).not.toHaveProperty('bvnSelfie');
    expect(rowA.onboarding).not.toHaveProperty('ninSelfie');
    expect(rowA.onboarding).not.toHaveProperty('liveSelfieKey');

    expect(rowA.loanSummary).toEqual({
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
    expect(rowA.loanEligibility.eligible).toBe(false);
  }, 20000);

  it(
    'GET /agent/clients/:clientId returns the client detail with loanSummary/loanEligibility/loanSchedule, and 404s for a client this agent does not own',
    async () => {
      const agentA = await prisma.agent.create({
        data: {
          email: `agent-view-a-${Date.now()}@example.com`,
          phone: '+2348012340004',
          fullName: 'Agent View A',
          address: '1 St',
          status: 'APPROVED',
          cvKey: 'agents/e2e/view-a.pdf',
          canOnboardClients: true,
        },
      });
      createdAgentIds.push(agentA.id);
      const agentB = await prisma.agent.create({
        data: {
          email: `agent-view-b-${Date.now()}@example.com`,
          phone: '+2348012340005',
          fullName: 'Agent View B',
          address: '1 St',
          status: 'APPROVED',
          cvKey: 'agents/e2e/view-b.pdf',
          canOnboardClients: true,
        },
      });
      createdAgentIds.push(agentB.id);
      const agentAToken = tokenService.signAccessToken({ sub: agentA.id, type: 'agent', canOnboardClients: true });
      const agentBToken = tokenService.signAccessToken({ sub: agentB.id, type: 'agent', canOnboardClients: true });

      const staffIdView = `E2E-MYCLIENTS-VIEW-${Date.now()}`;
      createdStaffIds.push(staffIdView);
      await prisma.ippisRecord.create({
        data: {
          agency: 'NPF',
          staffId: staffIdView,
          employeeName: 'Client View Test',
          phone: `+234814${Date.now().toString().slice(-7)}`,
        },
      });

      const createRes = await request(app.getHttpServer())
        .post('/agent/clients/onboarding/ippis-lookup')
        .set('Authorization', `Bearer ${agentAToken}`)
        .send({ ippisNumber: staffIdView })
        .expect(201);
      const clientId = createRes.body.clientId;
      createdClientIds.push(clientId);

      const viewRes = await request(app.getHttpServer())
        .get(`/agent/clients/${clientId}`)
        .set('Authorization', `Bearer ${agentAToken}`)
        .expect(200);
      expect(viewRes.body.id).toBe(clientId);
      expect(viewRes.body.loanSummary.hasLoan).toBe(false);
      expect(viewRes.body).toHaveProperty('loanEligibility');
      expect(viewRes.body).toHaveProperty('loanSchedule', null);

      await request(app.getHttpServer())
        .get(`/agent/clients/${clientId}`)
        .set('Authorization', `Bearer ${agentBToken}`)
        .expect(404);
    },
    20000,
  );

  it(
    'GET /agent/clients/:clientId reflects a PENDING loan request with a projected loanSchedule, before it is confirmed/disbursed',
    async () => {
      const agentA = await prisma.agent.create({
        data: {
          email: `agent-pending-${Date.now()}@example.com`,
          phone: '+2348012340006',
          fullName: 'Agent Pending',
          address: '1 St',
          status: 'APPROVED',
          cvKey: 'agents/e2e/pending.pdf',
          canOnboardClients: true,
        },
      });
      createdAgentIds.push(agentA.id);
      const agentAToken = tokenService.signAccessToken({ sub: agentA.id, type: 'agent', canOnboardClients: true });

      const staffIdPending = `E2E-MYCLIENTS-PENDING-${Date.now()}`;
      createdStaffIds.push(staffIdPending);
      await prisma.ippisRecord.create({
        data: {
          agency: 'NPF',
          staffId: staffIdPending,
          employeeName: 'Client Pending Request',
          phone: `+234815${Date.now().toString().slice(-7)}`,
        },
      });

      const createRes = await request(app.getHttpServer())
        .post('/agent/clients/onboarding/ippis-lookup')
        .set('Authorization', `Bearer ${agentAToken}`)
        .send({ ippisNumber: staffIdPending })
        .expect(201);
      const clientId = createRes.body.clientId;
      createdClientIds.push(clientId);

      await prisma.loanRequest.create({
        data: {
          clientId,
          amount: 90000,
          status: 'PENDING',
          tenorMonths: 3,
          interestRatePercent: 5,
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 1,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          managementChargeAmount: 900,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      });

      const viewRes = await request(app.getHttpServer())
        .get(`/agent/clients/${clientId}`)
        .set('Authorization', `Bearer ${agentAToken}`)
        .expect(200);

      expect(viewRes.body.loanSummary).toEqual(
        expect.objectContaining({ hasLoan: false, source: 'REQUEST', status: 'PENDING', principal: 90000 }),
      );
      expect(viewRes.body.loanSchedule).toHaveLength(4);
      expect(viewRes.body.loanSchedule[0]).toEqual(
        expect.objectContaining({ actualAmount: null, variance: null, status: 'UPCOMING' }),
      );
    },
    20000,
  );
});

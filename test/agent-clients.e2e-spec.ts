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
  }, 20000);
});

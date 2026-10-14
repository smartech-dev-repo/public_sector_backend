// test/agent-client-onboarding.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { hashPassword } from '../src/common/password-hash.util';

describe('Agent-initiated client onboarding (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  const createdClientIds: string[] = [];
  const createdStaffIds: string[] = [];
  const createdAgentIds: string[] = [];
  const documentTypes = ['NIN_CARD', 'WORK_ID', 'PASSPORT_PHOTO', 'SIGNATURE'];

  async function createAgent(emailPrefix: string, canOnboardClients: boolean) {
    const agent = await prisma.agent.create({
      data: {
        email: `${emailPrefix}-${Date.now()}@example.com`,
        phone: '+2348012340000',
        fullName: `E2E ${emailPrefix}`,
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: `agents/e2e/${emailPrefix}.pdf`,
        canOnboardClients,
      },
    });
    createdAgentIds.push(agent.id);
    const accessToken = tokenService.signAccessToken({ sub: agent.id, type: 'agent', canOnboardClients });
    return { agent, accessToken };
  }

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
    await prisma.clientDocument.deleteMany({ where: { clientOnboarding: { clientId: { in: createdClientIds } } } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: createdStaffIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
    await app.close();
  });

  it('rejects onboarding start for an agent without canOnboardClients', async () => {
    const { accessToken } = await createAgent('no-access', false);
    const staffId = `E2E-AGENT-NOACCESS-${Date.now()}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'No Access Client', phone: `+234806${Date.now().toString().slice(-7)}` },
    });

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(403);
  });

  it(
    'runs the full agent journey: ippis-lookup creates the client, identity verifies, 4 documents, passport face-match completes',
    async () => {
      const { agent, accessToken } = await createAgent('full-journey', true);
      const staffId = `E2E-AGENT-FULL-${Date.now()}`;
      const phone = `+234807${Date.now().toString().slice(-7)}`;
      createdStaffIds.push(staffId);
      await prisma.ippisRecord.create({
        data: { agency: 'NPF', staffId, employeeName: 'Agent Onboarded Client', bankName: 'Test Bank', accountNumber: '0000000020', phone },
      });

      const lookupRes = await request(app.getHttpServer())
        .post('/agent/clients/onboarding/ippis-lookup')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ippisNumber: staffId })
        .expect(201);
      expect(lookupRes.body.step).toBe('IPPIS_LINKED');
      const clientId = lookupRes.body.clientId;
      createdClientIds.push(clientId);

      await request(app.getHttpServer())
        .post(`/agent/clients/${clientId}/onboarding/identity`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ bvn: '12345678901', nin: '98765432109' })
        .expect(201)
        .expect((res) => {
          expect(res.body.step).toBe('IDENTITY_SUBMITTED');
          expect(res.body.identityVerified).toBe(true);
        });

      for (const documentType of documentTypes) {
        await request(app.getHttpServer())
          .post(`/agent/clients/${clientId}/onboarding/documents/${documentType}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
          .expect(201);
      }

      await request(app.getHttpServer())
        .post(`/agent/clients/${clientId}/onboarding/face-match`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(201)
        .expect((res) => {
          expect(res.body.step).toBe('COMPLETED');
          expect(res.body.faceMatchPassed).toBe(true);
        });

      const onboarding = await prisma.clientOnboarding.findUniqueOrThrow({ where: { clientId } });
      expect(onboarding.onboardedByAgentId).toBe(agent.id);
      expect(onboarding.onboardedById).toBeNull();

      const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(client.status).toBe('VERIFIED');
      expect(client.createdById).toBeNull();
    },
    20000,
  );

  it('resumes its own in-progress onboarding idempotently on a second ippis-lookup call', async () => {
    const { accessToken } = await createAgent('resume', true);
    const staffId = `E2E-AGENT-RESUME-${Date.now()}`;
    const phone = `+234808${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Resume Client', phone } });

    const firstRes = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    createdClientIds.push(firstRes.body.clientId);

    const secondRes = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    expect(secondRes.body.clientId).toBe(firstRes.body.clientId);
  });

  it('rejects a different agent from onboarding a client another agent already started', async () => {
    const { accessToken: firstAgentToken } = await createAgent('owner', true);
    const { accessToken: otherAgentToken } = await createAgent('intruder', true);
    const staffId = `E2E-AGENT-TAKEOVER-${Date.now()}`;
    const phone = `+234809${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Takeover Target', phone } });

    const firstRes = await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${firstAgentToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    createdClientIds.push(firstRes.body.clientId);

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${otherAgentToken}`)
      .send({ ippisNumber: staffId })
      .expect(409);
  });

  it('rejects an agent from onboarding a client who already self-onboarded', async () => {
    const { accessToken } = await createAgent('vs-self', true);
    const staffId = `E2E-AGENT-VSSELF-${Date.now()}`;
    const phone = `+234810${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Self Onboarded Client', phone } });

    const client = await prisma.client.create({ data: { phone } });
    createdClientIds.push(client.id);
    const clientAccessToken = tokenService.signAccessToken({ sub: client.id, type: 'client' });
    await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(409);
  });

  it('rejects an agent from onboarding a client who was already admin-onboarded', async () => {
    const { accessToken } = await createAgent('vs-admin', true);
    const staffId = `E2E-AGENT-VSADMIN-${Date.now()}`;
    const phone = `+234811${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({ data: { agency: 'NPF', staffId, employeeName: 'Admin Onboarded Client', phone } });

    const adminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    const adminAccessToken = adminLoginRes.body.accessToken;

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    createdClientIds.push(lookupRes.body.clientId);

    await request(app.getHttpServer())
      .post('/agent/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(409);
  });

  it('includes canOnboardClients in the JWT issued at real login', async () => {
    const plainPassword = 'a-strong-password';
    const agent = await prisma.agent.create({
      data: {
        email: `real-login-${Date.now()}@example.com`,
        phone: '+2348012340001',
        fullName: 'E2E Real Login Agent',
        address: '1 Example Street',
        status: 'APPROVED',
        cvKey: 'agents/e2e/real-login.pdf',
        canOnboardClients: true,
        passwordHash: await hashPassword(plainPassword),
      },
    });
    createdAgentIds.push(agent.id);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email: agent.email, password: plainPassword })
      .expect(200);
    const decoded = JSON.parse(Buffer.from(loginRes.body.accessToken.split('.')[1], 'base64url').toString());
    expect(decoded.canOnboardClients).toBe(true);
  });
});

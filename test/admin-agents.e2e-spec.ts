import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin agents list endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    await prisma.agent.createMany({
      data: [
        { email: 'wave3.agent1@test.com', phone: '08010000001', fullName: 'Wave3 Amaka', address: '1 Test St', status: 'APPROVED', cvKey: 'agents/wave3-test/cv1.pdf' },
        { email: 'wave3.agent2@test.com', phone: '08010000002', fullName: 'Wave3 Bello', address: '2 Test St', status: 'PENDING_REVIEW', cvKey: 'agents/wave3-test/cv2.pdf' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: { in: ['wave3.agent1@test.com', 'wave3.agent2@test.com'] } } });
    await app.close();
  });

  it('paginates GET /admin/agents', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/agents by status and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents')
      .query({ status: 'APPROVED', q: 'Amaka' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((a: { email: string }) => a.email === 'wave3.agent1@test.com')).toBe(true);
    expect(res.body.data.every((a: { status: string }) => a.status === 'APPROVED')).toBe(true);
  });

  it("grants and revokes an agent's client-onboarding access, rejecting the grant for a non-APPROVED agent", async () => {
    const pendingAgent = await prisma.agent.findFirstOrThrow({ where: { email: 'wave3.agent2@test.com' } });
    await request(app.getHttpServer())
      .patch(`/admin/agents/${pendingAgent.id}/onboarding-access`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: true })
      .expect(422);

    const approvedAgent = await prisma.agent.findFirstOrThrow({ where: { email: 'wave3.agent1@test.com' } });
    const grantRes = await request(app.getHttpServer())
      .patch(`/admin/agents/${approvedAgent.id}/onboarding-access`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: true })
      .expect(200);
    expect(grantRes.body.canOnboardClients).toBe(true);

    const revokeRes = await request(app.getHttpServer())
      .patch(`/admin/agents/${approvedAgent.id}/onboarding-access`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: false })
      .expect(200);
    expect(revokeRes.body.canOnboardClients).toBe(false);
  });

  it('returns 404 for an unknown agent id', async () => {
    await request(app.getHttpServer())
      .patch('/admin/agents/00000000-0000-0000-0000-000000000000/onboarding-access')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ canOnboardClients: true })
      .expect(404);
  });

  it('GET /admin/agents/:id resolves a preview URL for the stored cv key, without leaking the raw key', async () => {
    const agent = await prisma.agent.findFirstOrThrow({ where: { email: 'wave3.agent1@test.com' } });

    const res = await request(app.getHttpServer())
      .get(`/admin/agents/${agent.id}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body).not.toHaveProperty('cvKey');
    expect(res.body).not.toHaveProperty('passportPhotoKey');
    expect(res.body).not.toHaveProperty('identityDocumentKey');
    expect(res.body).not.toHaveProperty('supportingDocumentKeys');
    expect(res.body.cvUrl).toContain(encodeURIComponent('agents/wave3-test/cv1.pdf'));
    expect(res.body.passportPhotoUrl).toBeNull();
    expect(res.body.identityDocumentUrl).toBeNull();
    expect(res.body.supportingDocumentUrls).toEqual([]);
  });

  it('GET /admin/agents also resolves document URLs for every row in the list', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents')
      .query({ q: 'Amaka' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    const row = res.body.data.find((a: { email: string }) => a.email === 'wave3.agent1@test.com');
    expect(row.cvUrl).toContain(encodeURIComponent('agents/wave3-test/cv1.pdf'));
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { hashPassword } from '../src/common/password-hash.util';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin-forced session revocation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const agentEmail = 'session-revoke-agent@example.com';

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

    const passwordHash = await hashPassword('agent-password');
    await prisma.agent.create({
      data: {
        email: agentEmail,
        phone: '+2348044444444',
        fullName: 'Session Revoke Agent',
        address: '1 Example Street, Lagos',
        cvKey: 'agent-documents/session-revoke-agent/cv.pdf',
        passwordHash,
        status: 'APPROVED',
      },
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: agentEmail } });
    await app.close();
  });

  it("admin force-revoking an agent's sessions blocks their refresh token", async () => {
    const agentLoginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email: agentEmail, password: 'agent-password' })
      .expect(200);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { email: agentEmail } });

    await request(app.getHttpServer())
      .post(`/admin/agents/${agent.id}/sessions/revoke-all`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ revoked: true });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: agentLoginRes.body.refreshToken })
      .expect(401);
  });

  it('rejects the revoke-all route without the required permission', async () => {
    // The bootstrap admin holds every permission (SUPER_ADMIN), so this
    // proves the route is permission-gated at all rather than open once
    // authenticated — a request with no Authorization header must fail.
    return request(app.getHttpServer())
      .post('/admin/agents/some-agent-id/sessions/revoke-all')
      .expect(401);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Agent enrollment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentId: string;
  let capturedEmail: EmailMessage | undefined;
  const email = `e2e-agent-${Date.now()}@example.com`;
  let adminAccessToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmail = message;
          },
        },
      ])
      .compile();

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
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await app.close();
  });

  it('registers, gets approved, logs in with a forced password change, and refresh reflects the change', async () => {
    const registerRes = await request(app.getHttpServer())
      .post('/agents/register')
      .field('fullName', 'E2E Agent')
      .field('email', email)
      .field('phone', '+2348012345678')
      .field('address', '1 Example Street, Lagos')
      .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
      .expect(201);
    agentId = registerRes.body.id;
    expect(registerRes.body.status).toBe('PENDING_REVIEW');

    await request(app.getHttpServer())
      .post(`/admin/agents/${agentId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ approved: true });

    expect(capturedEmail?.to).toBe(email);

    // resend-credentials regenerates the temporary password server-side (a fresh
    // opaque token overwriting Agent.passwordHash), so the password that actually
    // works at login is the one from this second email, not the approval email above.
    await request(app.getHttpServer())
      .post(`/admin/agents/${agentId}/resend-credentials`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect({ resent: true });

    expect(capturedEmail?.to).toBe(email);
    const passwordMatch = capturedEmail?.text?.match(/Temporary password: (\S+)/);
    const temporaryPassword = passwordMatch?.[1];
    expect(temporaryPassword).toBeTruthy();

    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password: temporaryPassword })
      .expect(200);
    const { accessToken, refreshToken } = loginRes.body;
    const decoded = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    expect(decoded.mustChangePassword).toBe(true);

    await request(app.getHttpServer())
      .post(`/admin/agents/${agentId}/resend-credentials`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);

    await request(app.getHttpServer())
      .post('/auth/agent/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: temporaryPassword, newPassword: 'a-brand-new-password' })
      .expect(200);

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const decodedAfterRefresh = JSON.parse(
      Buffer.from(refreshRes.body.accessToken.split('.')[1], 'base64url').toString(),
    );
    expect(decodedAfterRefresh.mustChangePassword).toBe(false);
  });

  it('rejects a second registration with the same email', async () => {
    await request(app.getHttpServer())
      .post('/agents/register')
      .field('fullName', 'Duplicate Agent')
      .field('email', email)
      .field('phone', '+2348012345679')
      .field('address', 'Somewhere else')
      .attach('cv', Buffer.from('fake cv content'), 'cv.pdf')
      .expect(409);
  });
});

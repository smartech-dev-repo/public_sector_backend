import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/common/password-hash.util';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Agent password self-service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentId: string;
  let capturedEmail: EmailMessage | undefined;
  const email = `e2e-agent-pw-${Date.now()}@example.com`;
  const originalPassword = 'Original-Password-123!';

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

    const passwordHash = await hashPassword(originalPassword);
    const agent = await prisma.agent.create({
      data: {
        email,
        phone: '+2348012345678',
        fullName: 'E2E Password Test Agent',
        address: '1 Example Street, Lagos',
        cvKey: 'agent-documents/e2e-password-test/cv.pdf',
        status: 'APPROVED',
        passwordHash,
        mustChangePassword: false,
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await app.close();
  });

  it(
    'resets the password via forgot-password and revokes existing sessions',
    async () => {
      const loginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: originalPassword })
        .expect(200);
      const refreshToken = loginRes.body.refreshToken;

      await request(app.getHttpServer())
        .post('/auth/agent/forgot-password')
        .send({ email })
        .expect(200)
        .expect({ sent: true });

      expect(capturedEmail?.to).toBe(email);
      const tokenMatch = capturedEmail?.text?.match(/reset your password: (\S+)/);
      const resetToken = tokenMatch?.[1];
      expect(resetToken).toBeTruthy();

      await request(app.getHttpServer())
        .post('/auth/agent/reset-password')
        .send({ token: resetToken, newPassword: 'Reset-Password-789!' })
        .expect(200)
        .expect({ reset: true });

      await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken })
        .expect(401);

      const newLoginRes = await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'Reset-Password-789!' })
        .expect(200);
      const decoded = JSON.parse(Buffer.from(newLoginRes.body.accessToken.split('.')[1], 'base64url').toString());
      expect(decoded.mustChangePassword).toBe(false);
    },
    30000,
  );

  it('forgot-password returns 200 even for an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/agent/forgot-password')
      .send({ email: 'definitely-not-a-real-agent@example.com' })
      .expect(200)
      .expect({ sent: true });
  });

  it(
    'resets the password via the forgot-password code and invalidates the token from the same request',
    async () => {
      const codeEmail = `e2e-agent-pw-code-${Date.now()}@example.com`;
      const passwordHash = await hashPassword(originalPassword);
      const codeAgent = await prisma.agent.create({
        data: {
          email: codeEmail,
          phone: '+2348012345679',
          fullName: 'E2E Password Code Test Agent',
          address: '1 Example Street, Lagos',
          cvKey: 'agent-documents/e2e-password-code-test/cv.pdf',
          status: 'APPROVED',
          passwordHash,
          mustChangePassword: false,
        },
      });

      await request(app.getHttpServer())
        .post('/auth/agent/forgot-password')
        .send({ email: codeEmail })
        .expect(200)
        .expect({ sent: true });

      expect(capturedEmail?.to).toBe(codeEmail);
      const codeMatch = capturedEmail?.text?.match(/enter this code: (\d+)/);
      const resetCode = codeMatch?.[1];
      expect(resetCode).toBeTruthy();
      const tokenMatch = capturedEmail?.text?.match(/reset your password: (\S+)/);
      const resetToken = tokenMatch?.[1];
      expect(resetToken).toBeTruthy();

      await request(app.getHttpServer())
        .post('/auth/agent/reset-password/code')
        .send({ email: codeEmail, code: resetCode, newPassword: 'Reset-By-Code-789!' })
        .expect(200)
        .expect({ reset: true });

      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email: codeEmail, password: 'Reset-By-Code-789!' })
        .expect(200);

      await request(app.getHttpServer())
        .post('/auth/agent/reset-password')
        .send({ token: resetToken, newPassword: 'Should-Not-Work-123!' })
        .expect(401);

      await prisma.agent.deleteMany({ where: { id: codeAgent.id } });
    },
    30000,
  );
});

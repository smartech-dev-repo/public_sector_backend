import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/common/password-hash.util';

describe('Agent change-password with OTP confirmation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let agentId: string;
  let accessToken: string;
  const email = `e2e-change-pw-${Date.now()}@example.com`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const passwordHash = await hashPassword('Original-Password-123!');
    const agent = await prisma.agent.create({
      data: {
        email,
        phone: '+2348012399988',
        fullName: 'E2E Change Password Agent',
        address: '1 Example Street',
        cvKey: '',
        status: 'APPROVED',
        passwordHash,
      },
    });
    agentId = agent.id;

    const loginRes = await request(app.getHttpServer())
      .post('/auth/agent/login')
      .send({ email, password: 'Original-Password-123!' })
      .expect(200);
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: agentId } });
    await app.close();
  });

  // Runs first, deliberately, before any other test puts a change into a
  // pending state — this test's whole premise is that nothing is pending yet.
  it('rejects confirm/resend when no change is pending', async () => {
    await request(app.getHttpServer())
      .post('/auth/agent/change-password/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: '123456' })
      .expect(409);

    await request(app.getHttpServer())
      .post('/auth/agent/change-password/resend')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it(
    'initiating stores a pending code but does not change the password until confirmed',
    async () => {
      const initiateRes = await request(app.getHttpServer())
        .post('/auth/agent/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'Original-Password-123!', newPassword: 'New-Password-456!' })
        .expect(200);
      expect(initiateRes.body.sent).toBe(true);

      const updatedAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(updatedAgent.changePasswordPendingHash).toBeTruthy();
      expect(updatedAgent.changePasswordCodeHash).toBeTruthy();

      // Wrong code is rejected, and the original password still logs in --
      // proving the change hasn't been applied yet.
      await request(app.getHttpServer())
        .post('/auth/agent/change-password/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: '000000' })
        .expect(401);

      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'Original-Password-123!' })
        .expect(200);
    },
    20000,
  );

  it(
    'resend issues a fresh code; with EMAIL_CODE_DEV_ECHO on, confirming it completes the change and clears the pending state',
    async () => {
      const resendRes = await request(app.getHttpServer())
        .post('/auth/agent/change-password/resend')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(resendRes.body.sent).toBe(true);

      if (!resendRes.body.devCode) {
        // EMAIL_CODE_DEV_ECHO isn't set in this environment -- there's no way
        // to read the real code back out (it's hashed), so this test can only
        // verify the request succeeded, not the full confirm path. See this
        // task's note on setting EMAIL_CODE_DEV_ECHO=true locally to exercise
        // the complete flow.
        return;
      }

      const confirmRes = await request(app.getHttpServer())
        .post('/auth/agent/change-password/confirm')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ code: resendRes.body.devCode })
        .expect(200);
      expect(confirmRes.body.accessToken).toEqual(expect.any(String));

      const updatedAgent = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      expect(updatedAgent.changePasswordPendingHash).toBeNull();
      expect(updatedAgent.mustChangePassword).toBe(false);

      // The new password now works; the old one no longer does.
      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'New-Password-456!' })
        .expect(200);
      await request(app.getHttpServer())
        .post('/auth/agent/login')
        .send({ email, password: 'Original-Password-123!' })
        .expect(401);
    },
    20000,
  );
});

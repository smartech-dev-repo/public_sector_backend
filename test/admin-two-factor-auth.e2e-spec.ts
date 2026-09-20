import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { hashPassword } from '../src/common/password-hash.util';
import { generateSecret, generate } from 'otplib';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin two-factor authentication (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capturedEmail: EmailMessage | undefined;
  const password = 'Original-Password-123!';

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
  });

  afterAll(async () => {
    await app.close();
  });

  async function createAdminAndLogin(email: string) {
    const passwordHash = await hashPassword(password);
    const admin = await prisma.adminUser.create({
      data: { email, passwordHash, fullName: 'E2E 2FA Test Admin' },
    });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    return { adminId: admin.id, accessToken: loginRes.body.accessToken };
  }

  it('completes a full TOTP setup, login, and disable round-trip', async () => {
    const email = `e2e-2fa-totp-${Date.now()}@example.com`;
    const { adminId, accessToken } = await createAdminAndLogin(email);

    const setupRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ method: 'TOTP' })
      .expect(200);
    const secret = setupRes.body.secret;
    expect(secret).toBeTruthy();

    const validCode = await generate({ secret });
    await request(app.getHttpServer())
      .post('/auth/admin/2fa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: validCode })
      .expect(200)
      .expect({ enabled: true });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    expect(loginRes.body.twoFactorRequired).toBe(true);
    expect(loginRes.body.method).toBe('TOTP');
    const pendingToken = loginRes.body.pendingToken;

    const loginCode = await generate({ secret });
    const verifyRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken, code: loginCode })
      .expect(200);
    expect(verifyRes.body.accessToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/disable')
      .set('Authorization', `Bearer ${verifyRes.body.accessToken}`)
      .send({ currentPassword: password })
      .expect(200)
      .expect({ disabled: true });

    const finalLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    expect(finalLoginRes.body.twoFactorRequired).toBeUndefined();
    expect(finalLoginRes.body.accessToken).toBeTruthy();

    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }, 30000);

  it('completes a full email-OTP setup and login round-trip', async () => {
    const email = `e2e-2fa-email-${Date.now()}@example.com`;
    const { adminId, accessToken } = await createAdminAndLogin(email);

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ method: 'EMAIL' })
      .expect(200)
      .expect({ method: 'EMAIL' });

    expect(capturedEmail?.to).toBe(email);
    let codeMatch = capturedEmail?.text?.match(/verification code is: (\d{6})/);
    const setupCode = codeMatch?.[1];
    expect(setupCode).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: setupCode })
      .expect(200)
      .expect({ enabled: true });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    expect(loginRes.body.twoFactorRequired).toBe(true);
    expect(loginRes.body.method).toBe('EMAIL');

    codeMatch = capturedEmail?.text?.match(/verification code is: (\d{6})/);
    const loginCode = codeMatch?.[1];

    const verifyRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken: loginRes.body.pendingToken, code: loginCode })
      .expect(200);
    expect(verifyRes.body.accessToken).toBeTruthy();

    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }, 30000);

  it('rejects a login-verify call with a wrong code without invalidating the pending token', async () => {
    const email = `e2e-2fa-retry-${Date.now()}@example.com`;
    const { adminId, accessToken } = await createAdminAndLogin(email);

    const setupRes = await request(app.getHttpServer())
      .post('/auth/admin/2fa/setup')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ method: 'TOTP' })
      .expect(200);
    const secret = setupRes.body.secret;
    const setupCode = await generate({ secret });
    await request(app.getHttpServer())
      .post('/auth/admin/2fa/confirm')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: setupCode })
      .expect(200);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password })
      .expect(200);
    const pendingToken = loginRes.body.pendingToken;

    await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken, code: '000000' })
      .expect(401);

    const validCode = await generate({ secret });
    await request(app.getHttpServer())
      .post('/auth/admin/2fa/login-verify')
      .send({ pendingToken, code: validCode })
      .expect(200);

    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }, 30000);
});

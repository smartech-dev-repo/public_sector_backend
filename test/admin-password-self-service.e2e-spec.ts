import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { hashPassword } from '../src/common/password-hash.util';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin password self-service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminId: string;
  let testRoleId: string;
  let capturedEmail: EmailMessage | undefined;
  const email = `e2e-admin-pw-${Date.now()}@example.com`;
  const originalPassword = 'Original-Password-123!';
  const testRoleName = `E2E_PW_ROLE_${Date.now()}`;

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

    const testRole = await prisma.role.create({ data: { name: testRoleName } });
    testRoleId = testRole.id;

    const passwordHash = await hashPassword(originalPassword);
    const admin = await prisma.adminUser.create({
      data: { email, passwordHash, fullName: 'E2E Password Test Admin', roleId: testRoleId },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
    await prisma.role.deleteMany({ where: { id: testRoleId } });
    await app.close();
  });

  it('changes the password via the authenticated change-password endpoint', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: originalPassword })
      .expect(200);
    const accessToken = loginRes.body.accessToken;

    await request(app.getHttpServer())
      .post('/auth/admin/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword: originalPassword, newPassword: 'Changed-Password-456!' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: originalPassword })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: 'Changed-Password-456!' })
      .expect(200);
  });

  it('resets the password via forgot-password and revokes existing sessions', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: 'Changed-Password-456!' })
      .expect(200);
    const refreshToken = loginRes.body.refreshToken;

    await request(app.getHttpServer())
      .post('/auth/admin/forgot-password')
      .send({ email })
      .expect(200)
      .expect({ sent: true });

    expect(capturedEmail?.to).toBe(email);
    const tokenMatch = capturedEmail?.text?.match(/reset your password: (\S+)/);
    const resetToken = tokenMatch?.[1];
    expect(resetToken).toBeTruthy();

    await request(app.getHttpServer())
      .post('/auth/admin/reset-password')
      .send({ token: resetToken, newPassword: 'Reset-Password-789!' })
      .expect(200)
      .expect({ reset: true });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email, password: 'Reset-Password-789!' })
      .expect(200);
  });

  it('forgot-password returns 200 even for an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/admin/forgot-password')
      .send({ email: 'definitely-not-a-real-admin@example.com' })
      .expect(200)
      .expect({ sent: true });
  });
});

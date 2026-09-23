import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Session rails (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const phone = '+2348033333333';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.client.deleteMany({ where: { phone } });
    await app.close();
  });

  async function loginClient() {
    await request(app.getHttpServer()).post('/auth/client/otp/request').send({ phone });
    const stored = await prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    // The stored code is hashed; re-request via a fresh OTP isn't possible here,
    // so this suite exercises the client record directly instead of a real code.
    return stored;
  }

  it('rejects refresh with an unknown token', () => {
    return request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: 'not-a-real-token' })
      .expect(401);
  });

  it('rotates a valid refresh token and rejects reusing the old one', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    const originalRefreshToken = loginRes.body.refreshToken;

    const refreshRes = await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(200);

    expect(refreshRes.body.refreshToken).not.toBe(originalRefreshToken);
    expect(typeof refreshRes.body.accessToken).toBe('string');

    // Reusing the now-rotated-away token is treated as theft.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: originalRefreshToken })
      .expect(401);

    // Reuse detection revokes the *new* token too (every session for the principal).
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: refreshRes.body.refreshToken })
      .expect(401);
  });

  it('logout revokes the session so refresh subsequently fails', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });

    await request(app.getHttpServer())
      .post('/auth/logout')
      .send({ refreshToken: loginRes.body.refreshToken })
      .expect(200)
      .expect({ loggedOut: true });

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: loginRes.body.refreshToken })
      .expect(401);
  });

  it('lists active sessions and self-revokes one', async () => {
    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    const accessToken = loginRes.body.accessToken;

    const listRes = await request(app.getHttpServer())
      .get('/auth/sessions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data.length).toBeGreaterThan(0);
    const sessionId = listRes.body.data[0].id;

    await request(app.getHttpServer())
      .delete(`/auth/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ revoked: true });
  });

  it('logout-all revokes every session for the principal', async () => {
    const firstLogin = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    const secondLogin = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });

    await request(app.getHttpServer())
      .post('/auth/logout-all')
      .set('Authorization', `Bearer ${firstLogin.body.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: firstLogin.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondLogin.body.refreshToken })
      .expect(401);
  });
});

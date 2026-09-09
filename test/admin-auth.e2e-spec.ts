import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Admin auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects bad credentials with 401', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' })
      .expect(401);
  });

  it('logs in the seeded bootstrap admin', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      })
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.accessToken).toBe('string');
        expect(typeof res.body.refreshToken).toBe('string');
      });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Rate limiting (e2e, isolated)', () => {
  let app: INestApplication;
  const originalValue = process.env.RATE_LIMITING_ENABLED;

  beforeAll(async () => {
    process.env.RATE_LIMITING_ENABLED = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (originalValue === undefined) {
      delete process.env.RATE_LIMITING_ENABLED;
    } else {
      process.env.RATE_LIMITING_ENABLED = originalValue;
    }
  });

  it('returns 429 after exceeding the sensitive limit on a rate-limited route', async () => {
    const phone = `+234801${Date.now().toString().slice(-7)}`;

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).post('/auth/client/otp/request').send({ phone });
    }

    await request(app.getHttpServer())
      .post('/auth/client/otp/request')
      .send({ phone })
      .expect(429);
  });
});

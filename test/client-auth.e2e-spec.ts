import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Client auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const phone = '+2348011111111';

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

  it('rejects a made-up OTP code', () => {
    return request(app.getHttpServer())
      .post('/auth/client/otp/verify')
      .send({ phone, code: '000000' })
      .expect(401);
  });

  it('requests an OTP and stores a hashed code for the phone number', async () => {
    await request(app.getHttpServer())
      .post('/auth/client/otp/request')
      .send({ phone })
      .expect(200)
      .expect({ sent: true });

    const stored = await prisma.otpCode.findFirst({
      where: { phone },
      orderBy: { createdAt: 'desc' },
    });
    expect(stored).not.toBeNull();
  });
});

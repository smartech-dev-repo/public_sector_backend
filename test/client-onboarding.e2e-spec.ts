import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Client onboarding (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let accessToken: string;
  const phone = `+234800${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-ONBOARD-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const client = await prisma.client.create({ data: { phone } });
    clientId = client.id;
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'E2E Onboarding Test',
        bankName: 'Test Bank',
        accountNumber: '0000000000',
      },
    });

    const tokenService = moduleFixture.get(TokenService);
    accessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('rejects a non-client token', async () => {
    return request(app.getHttpServer())
      .get('/client/onboarding/status')
      .expect(401);
  });

  it('returns PHONE_VERIFIED before any onboarding step has run', () => {
    return request(app.getHttpServer())
      .get('/client/onboarding/status')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.step).toBe('PHONE_VERIFIED');
      });
  });

  it('walks the client through IPPIS link, identity, and face match to COMPLETED', async () => {
    await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IPPIS_LINKED');
        expect(res.body.employeeName).toBe('E2E Onboarding Test');
      });

    await request(app.getHttpServer())
      .post('/client/onboarding/identity')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IDENTITY_SUBMITTED');
        expect(res.body.identityVerified).toBe(true);
      });

    await request(app.getHttpServer())
      .post('/client/onboarding/face-match')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('selfie', Buffer.from('fake-selfie-bytes'), 'selfie.jpg')
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
        expect(res.body.faceMatchPassed).toBe(true);
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin client review (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let clientId: string;
  const phone = `+234801${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-REVIEW-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

    const client = await prisma.client.create({ data: { phone } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'E2E Review Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E Review Test',
        agency: 'NPF',
        bvn: '12345678901',
        nin: '98765432109',
        bvnSelfie: 'client-onboarding/x/bvn-selfie.jpg',
        ninSelfie: 'client-onboarding/x/nin-selfie.jpg',
        identityVerified: true,
        liveSelfieKey: 'client-onboarding/x/live-selfie.jpg',
        faceMatchBvnScore: 0.95,
        faceMatchNinScore: 0.2,
        faceMatchPassed: false,
        step: 'FACE_MATCH_PENDING',
        failureReasons: { identityVerified: true, faceMatchPassed: false },
      },
    });
    await prisma.client.update({ where: { id: clientId }, data: { status: 'MANUAL_REVIEW' } });
  });

  afterAll(async () => {
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('rejects an unauthenticated request', () => {
    return request(app.getHttpServer()).get('/admin/clients').expect(401);
  });

  it('lists clients filtered by MANUAL_REVIEW status', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/clients')
      .query({ status: 'MANUAL_REVIEW' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.some((c: { id: string }) => c.id === clientId)).toBe(true);
  });

  it('gets the full client detail including onboarding', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.onboarding.faceMatchPassed).toBe(false);
  });

  it('retries: resets to IDENTITY_SUBMITTED since only the face match failed', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/retry`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ note: 'blurry selfie, please retake' })
      .expect(200);
    expect(res.body.status).toBe('PENDING_IPPIS');

    const onboarding = await prisma.clientOnboarding.findUnique({ where: { clientId } });
    expect(onboarding!.step).toBe('IDENTITY_SUBMITTED');
    expect(onboarding!.bvn).toBe('12345678901');
    expect(onboarding!.liveSelfieKey).toBeNull();
  });

  it('rejects approve/retry once the client is no longer in MANUAL_REVIEW', () => {
    return request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/approve`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(409);
  });
});

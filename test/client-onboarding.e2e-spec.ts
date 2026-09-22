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
  let secondaryClientId: string;
  let secondaryAccessToken: string;
  let secondaryOnboardingId: string;
  let adminAccessToken: string;
  const phone = `+234800${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-ONBOARD-${Date.now()}`;
  const secondaryPhone = `+234802${Date.now().toString().slice(-7)}`;
  const secondaryStaffId = `E2E-ONBOARD2-${Date.now()}`;
  const documentTypes = ['NIN_CARD', 'WORK_ID', 'PASSPORT_PHOTO', 'SIGNATURE'];

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

    const secondaryClient = await prisma.client.create({ data: { phone: secondaryPhone } });
    secondaryClientId = secondaryClient.id;
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId: secondaryStaffId,
        employeeName: 'E2E Onboarding Secondary',
        bankName: 'Test Bank',
        accountNumber: '0000000001',
      },
    });
    secondaryAccessToken = tokenService.signAccessToken({ sub: secondaryClientId, type: 'client' });

    const adminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({
        email: process.env.BOOTSTRAP_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
      });
    adminAccessToken = adminLoginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.clientDocument.deleteMany({
      where: { clientOnboarding: { clientId: { in: [clientId, secondaryClientId] } } },
    });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: [clientId, secondaryClientId] } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: [staffId, secondaryStaffId] } } });
    await prisma.client.deleteMany({ where: { id: { in: [clientId, secondaryClientId] } } });
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

    for (const [index, documentType] of documentTypes.entries()) {
      await request(app.getHttpServer())
        .post(`/client/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201)
        .expect((res) => {
          expect(res.body.documentType).toBe(documentType);
        });

      const status = await request(app.getHttpServer())
        .get('/client/onboarding/status')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      if (index < documentTypes.length - 1) {
        expect(status.body.step).toBe('IDENTITY_SUBMITTED');
      } else {
        expect(status.body.step).toBe('DOCUMENTS_SUBMITTED');
      }
    }

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
  }, 20000);

  it('rejects a document upload before identity has been submitted', async () => {
    await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${secondaryAccessToken}`)
      .send({ ippisNumber: secondaryStaffId })
      .expect(201)
      .expect((res) => {
        secondaryOnboardingId = res.body.id;
        expect(res.body.step).toBe('IPPIS_LINKED');
      });

    await request(app.getHttpServer())
      .post('/client/onboarding/documents/NIN_CARD')
      .set('Authorization', `Bearer ${secondaryAccessToken}`)
      .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
      .expect(409);
  });

  it('re-uploading a document type at DOCUMENTS_SUBMITTED replaces the row instead of duplicating it', async () => {
    await request(app.getHttpServer())
      .post('/client/onboarding/identity')
      .set('Authorization', `Bearer ${secondaryAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IDENTITY_SUBMITTED');
      });

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/client/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${secondaryAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    const statusAfterAllUploads = await request(app.getHttpServer())
      .get('/client/onboarding/status')
      .set('Authorization', `Bearer ${secondaryAccessToken}`)
      .expect(200);
    expect(statusAfterAllUploads.body.step).toBe('DOCUMENTS_SUBMITTED');

    await request(app.getHttpServer())
      .post('/client/onboarding/documents/NIN_CARD')
      .set('Authorization', `Bearer ${secondaryAccessToken}`)
      .attach('file', Buffer.from('a-different-fake-image'), { filename: 'doc-v2.jpg', contentType: 'image/jpeg' })
      .expect(201);

    const count = await prisma.clientDocument.count({
      where: { clientOnboardingId: secondaryOnboardingId, documentType: 'NIN_CARD' },
    });
    expect(count).toBe(1);
  });

  it('lets admin see resolved document URLs for a client with completed document upload', async () => {
    const res = await request(app.getHttpServer())
      .get(`/admin/clients/${secondaryClientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(res.body.onboarding.step).toBe('DOCUMENTS_SUBMITTED');
    expect(res.body.onboarding.documents).toHaveLength(4);

    const returnedTypes = res.body.onboarding.documents
      .map((document: { documentType: string }) => document.documentType)
      .sort();
    expect(returnedTypes).toEqual(['NIN_CARD', 'PASSPORT_PHOTO', 'SIGNATURE', 'WORK_ID']);

    for (const document of res.body.onboarding.documents) {
      expect(typeof document.url).toBe('string');
      expect(document.url.length).toBeGreaterThan(0);
      expect(document.uploadedAt).toBeDefined();
    }
  });
});

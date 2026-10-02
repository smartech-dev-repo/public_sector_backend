import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Admin-initiated client onboarding (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokenService: TokenService;
  let adminAccessToken: string;
  const createdClientIds: string[] = [];
  const createdStaffIds: string[] = [];
  const documentTypes = ['NIN_CARD', 'WORK_ID', 'PASSPORT_PHOTO', 'SIGNATURE'];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    tokenService = moduleFixture.get(TokenService);

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
      where: { clientOnboarding: { clientId: { in: createdClientIds } } },
    });
    await prisma.clientOnboarding.deleteMany({ where: { clientId: { in: createdClientIds } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: createdStaffIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await app.close();
  });

  it('runs the full admin journey: ippis-lookup creates the client, identity verifies, 4 documents, passport face-match completes', async () => {
    const staffId = `E2E-ADMIN-ONBOARD-${Date.now()}`;
    const phone = `+234803${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'Admin Onboarded Client',
        bankName: 'Test Bank',
        accountNumber: '0000000010',
        phone,
      },
    });

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    expect(lookupRes.body.step).toBe('IPPIS_LINKED');
    const clientId = lookupRes.body.clientId;
    createdClientIds.push(clientId);

    const createdClient = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(createdClient.phone).toBe(phone);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('IDENTITY_SUBMITTED');
        expect(res.body.identityVerified).toBe(true);
      });

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/admin/clients/${clientId}/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/face-match`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
        expect(res.body.faceMatchPassed).toBe(true);
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');

    await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.createdByAdmin).not.toBeNull();
        expect(res.body.onboarding.onboardedByAdmin).not.toBeNull();
      });
  }, 20000);

  it('returns 422 when the IPPIS record has no phone number on file', async () => {
    const staffId = `E2E-ADMIN-NOPHONE-${Date.now()}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'No Phone Client',
        bankName: 'Test Bank',
        accountNumber: '0000000011',
      },
    });

    await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(422);
  });

  it('returns 404 for an unknown IPPIS number', async () => {
    await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: 'NOT-A-REAL-STAFF-ID' })
      .expect(404);
  });

  it('resumes an admin-started onboarding when the client later logs in and calls ippis-link themselves', async () => {
    const staffId = `E2E-ADMIN-RESUME-${Date.now()}`;
    const phone = `+234804${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'Resume Flow Client',
        bankName: 'Test Bank',
        accountNumber: '0000000012',
        phone,
      },
    });

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    const clientId = lookupRes.body.clientId;
    createdClientIds.push(clientId);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201);

    const clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });

    const resumeRes = await request(app.getHttpServer())
      .post('/client/onboarding/ippis-link')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    expect(resumeRes.body.step).toBe('IDENTITY_SUBMITTED');
    expect(resumeRes.body.clientId).toBe(clientId);

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/client/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${clientAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post('/client/onboarding/face-match')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .attach('selfie', Buffer.from('fake-selfie-bytes'), 'selfie.jpg')
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');
  }, 20000);

  it('lets a client submit a real selfie to re-confirm after admin already completed onboarding via passport photo', async () => {
    const staffId = `E2E-ADMIN-RECONFIRM-${Date.now()}`;
    const phone = `+234805${Date.now().toString().slice(-7)}`;
    createdStaffIds.push(staffId);
    await prisma.ippisRecord.create({
      data: {
        agency: 'NPF',
        staffId,
        employeeName: 'Reconfirm Flow Client',
        bankName: 'Test Bank',
        accountNumber: '0000000013',
        phone,
      },
    });

    const lookupRes = await request(app.getHttpServer())
      .post('/admin/clients/onboarding/ippis-lookup')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ ippisNumber: staffId })
      .expect(201);
    const clientId = lookupRes.body.clientId;
    createdClientIds.push(clientId);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/identity`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ bvn: '12345678901', nin: '98765432109' })
      .expect(201);

    for (const documentType of documentTypes) {
      await request(app.getHttpServer())
        .post(`/admin/clients/${clientId}/onboarding/documents/${documentType}`)
        .set('Authorization', `Bearer ${adminAccessToken}`)
        .attach('file', Buffer.from('fake-image-data'), { filename: 'doc.jpg', contentType: 'image/jpeg' })
        .expect(201);
    }

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/onboarding/face-match`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
      });

    const clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });

    await request(app.getHttpServer())
      .post('/client/onboarding/face-match')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .attach('selfie', Buffer.from('real-selfie-bytes'), 'selfie.jpg')
      .expect(201)
      .expect((res) => {
        expect(res.body.step).toBe('COMPLETED');
        expect(res.body.faceMatchPassed).toBe(true);
      });

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(client.status).toBe('VERIFIED');
  }, 20000);
});

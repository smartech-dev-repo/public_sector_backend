// test/file-download.e2e-spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';
import { SAMPLE_JPEG_BUFFER } from './fixtures/sample-files';

describe('File download endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clientId: string;
  let adminAccessToken: string;
  const phone = `+234806${Date.now().toString().slice(-7)}`;
  const staffId = `E2E-FILEDL-${Date.now()}`;

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
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;
    const ippisRecord = await prisma.ippisRecord.create({
      data: { agency: 'NPF', staffId, employeeName: 'E2E File Download Test' },
    });
    await prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: 'E2E File Download Test',
        agency: 'NPF',
        step: 'IDENTITY_SUBMITTED',
      },
    });
  });

  afterAll(async () => {
    await prisma.clientDocument.deleteMany({ where: { clientOnboarding: { clientId } } });
    await prisma.clientOnboarding.deleteMany({ where: { clientId } });
    await prisma.ippisRecord.deleteMany({ where: { staffId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('serves an uploaded document with the correct Content-Type and the exact original bytes', async () => {
    const tokenService = app.get(TokenService);
    const clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });

    const uploadRes = await request(app.getHttpServer())
      .post('/client/onboarding/documents/NIN_CARD')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .attach('file', SAMPLE_JPEG_BUFFER, { filename: 'doc.jpg', contentType: 'image/jpeg' })
      .expect(201);

    expect(uploadRes.body).toEqual({
      documentType: 'NIN_CARD',
      uploadedAt: expect.any(String),
      url: expect.any(String),
    });

    // FileDownloadController requires an admin JWT carrying a `permissions`
    // array (RequirePermissions('documents:read') via PermissionsGuard) —
    // client/agent tokens never carry a permissions array at all (that's an
    // admin-RBAC-only concept in this codebase), so this must use the admin
    // token, not the client token that performed the upload.
    const downloadRes = await request(app.getHttpServer())
      .get(uploadRes.body.url)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);

    expect(downloadRes.headers['content-type']).toMatch(/^image\/jpeg/);
    expect(Buffer.compare(downloadRes.body, SAMPLE_JPEG_BUFFER)).toBe(0);
  });
});

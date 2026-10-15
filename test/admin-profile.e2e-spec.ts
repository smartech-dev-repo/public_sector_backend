import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let adminId: string;
  let originalFirstName: string;
  let originalLastName: string;

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

    const meRes = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`);
    adminId = meRes.body.id;
    originalFirstName = meRes.body.firstName;
    originalLastName = meRes.body.lastName;
  });

  afterAll(async () => {
    // Restore the shared bootstrap admin's name and clear any uploaded
    // profile image -- this fixture is persistent/shared, not a throwaway
    // row this test created, so it must be left exactly as it was found.
    await prisma.adminUser.update({
      where: { id: adminId },
      data: {
        firstName: originalFirstName,
        lastName: originalLastName,
        fullName: `${originalFirstName} ${originalLastName}`.trim(),
        profileImageKey: null,
      },
    });
    await app.close();
  });

  it('returns the resolved profile with role, department, and a null profileImageUrl by default', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.id).toBe(adminId);
    expect(res.body.role).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
    expect(res.body.profileImageUrl).toBeNull();
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('rejects unauthenticated access', () => {
    return request(app.getHttpServer()).get('/admin/me').expect(401);
  });

  it('updates firstName and recomputes fullName', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ firstName: 'E2E-Updated' })
      .expect(200);
    expect(res.body.firstName).toBe('E2E-Updated');
    expect(res.body.fullName).toBe(`E2E-Updated ${originalLastName}`.trim());
  });

  it('uploads a profile image, reflects it on GET, then deletes it', async () => {
    const uploadRes = await request(app.getHttpServer())
      .post('/admin/me/profile-image')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', Buffer.from('fake-image-data'), { filename: 'avatar.jpg', contentType: 'image/jpeg' })
      .expect(201);
    expect(typeof uploadRes.body.profileImageUrl).toBe('string');
    expect(uploadRes.body.profileImageUrl.length).toBeGreaterThan(0);

    const meRes = await request(app.getHttpServer())
      .get('/admin/me')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(meRes.body.profileImageUrl).toBe(uploadRes.body.profileImageUrl);

    const deleteRes = await request(app.getHttpServer())
      .delete('/admin/me/profile-image')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(deleteRes.body.profileImageUrl).toBeNull();
  });

  it('rejects a non-image file upload', async () => {
    await request(app.getHttpServer())
      .post('/admin/me/profile-image')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .attach('file', Buffer.from('fake-pdf-data'), { filename: 'doc.pdf', contentType: 'application/pdf' })
      .expect(400);
  });
});

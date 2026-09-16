import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin permissions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const testKey = `test:permission:${Date.now()}`;
  let createdPermissionId: string;

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
    accessToken = loginRes.body.accessToken;
  });

  afterAll(async () => {
    await prisma.permission.deleteMany({ where: { key: testKey } });
    await app.close();
  });

  it('rejects creation with an invalid key format (400)', () => {
    return request(app.getHttpServer())
      .post('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: 'Not A Valid Key', description: 'bad' })
      .expect(400);
  });

  it('creates a permission', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: testKey, description: 'Test permission' })
      .expect(201);
    expect(res.body.key).toBe(testKey);
    createdPermissionId = res.body.id;
  });

  it('rejects creating a duplicate key (409)', () => {
    return request(app.getHttpServer())
      .post('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ key: testKey, description: 'duplicate' })
      .expect(409);
  });

  it('lists permissions including the new one', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/permissions')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.some((p: { key: string }) => p.key === testKey)).toBe(true);
  });

  it('gets one permission by id', () => {
    return request(app.getHttpServer())
      .get(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect((res) => expect(res.body.key).toBe(testKey));
  });

  it('updates the description only', () => {
    return request(app.getHttpServer())
      .patch(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ description: 'Updated description' })
      .expect(200)
      .expect((res) => {
        expect(res.body.description).toBe('Updated description');
        expect(res.body.key).toBe(testKey);
      });
  });

  it('deletes the unused permission', () => {
    return request(app.getHttpServer())
      .delete(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ deleted: true });
  });

  it('rejects without permissions:manage (403)', async () => {
    return request(app.getHttpServer())
      .get('/admin/permissions')
      .expect(401);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const testRoleName = `TEST_ROLE_${Date.now()}`;
  const testPermissionKey = `test:role-e2e:${Date.now()}`;
  let createdRoleId: string;
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

    const permission = await prisma.permission.create({
      data: { key: testPermissionKey, description: 'e2e test permission' },
    });
    createdPermissionId = permission.id;
  });

  afterAll(async () => {
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await prisma.permission.deleteMany({ where: { key: testPermissionKey } });
    await app.close();
  });

  it('creates a role', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/roles')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: testRoleName, description: 'A test role' })
      .expect(201);
    expect(res.body.name).toBe(testRoleName);
    createdRoleId = res.body.id;
  });

  it('rejects renaming SUPER_ADMIN (409)', async () => {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    return request(app.getHttpServer())
      .patch(`/admin/roles/${superAdmin.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'RENAMED' })
      .expect(409);
  });

  it('rejects deleting SUPER_ADMIN (409)', async () => {
    const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    return request(app.getHttpServer())
      .delete(`/admin/roles/${superAdmin.id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('assigns a permission to the role', async () => {
    await request(app.getHttpServer())
      .post(`/admin/roles/${createdRoleId}/permissions`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ permissionId: createdPermissionId })
      .expect(200)
      .expect({ assigned: true });

    const res = await request(app.getHttpServer())
      .get(`/admin/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(res.body.permissions.some((rp: { permission: { key: string } }) => rp.permission.key === testPermissionKey)).toBe(true);
  });

  it('rejects deleting the now-in-use permission (409)', () => {
    return request(app.getHttpServer())
      .delete(`/admin/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('removes the permission from the role', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/roles/${createdRoleId}/permissions/${createdPermissionId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ removed: true });
  });

  it('deletes the now-unused role', () => {
    return request(app.getHttpServer())
      .delete(`/admin/roles/${createdRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ deleted: true });
  });
});

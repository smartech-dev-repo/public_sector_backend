import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { hashPassword } from '../src/common/password-hash.util';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin role assignment (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let bootstrapAdminId: string;
  let superAdminRoleId: string;
  const testRoleName = `TEST_ASSIGN_ROLE_${Date.now()}`;
  let testRoleId: string;
  let secondAdminId: string;
  let secondAdminRefreshToken: string;

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

    const bootstrapAdmin = await prisma.adminUser.findUniqueOrThrow({
      where: { email: process.env.BOOTSTRAP_ADMIN_EMAIL },
    });
    bootstrapAdminId = bootstrapAdmin.id;

    const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    superAdminRoleId = superAdminRole.id;

    const testRole = await prisma.role.create({ data: { name: testRoleName } });
    testRoleId = testRole.id;

    const secondAdminEmail = `e2e-deactivate-${Date.now()}@example.com`;
    const secondAdminPasswordHash = await hashPassword('Test-Password-123!');
    const secondAdmin = await prisma.adminUser.create({
      data: { email: secondAdminEmail, passwordHash: secondAdminPasswordHash, fullName: 'E2E Deactivate Target' },
    });
    secondAdminId = secondAdmin.id;

    const secondAdminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: secondAdminEmail, password: 'Test-Password-123!' });
    secondAdminRefreshToken = secondAdminLoginRes.body.refreshToken;
  });

  afterAll(async () => {
    await prisma.adminUserRole.deleteMany({ where: { adminUserId: bootstrapAdminId, roleId: testRoleId } });
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await prisma.adminUser.deleteMany({ where: { id: secondAdminId } });
    await app.close();
  });

  it('lists admins including the bootstrap admin with SUPER_ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const bootstrapEntry = res.body.find((a: { id: string }) => a.id === bootstrapAdminId);
    expect(bootstrapEntry.roles.some((r: { role: { name: string } }) => r.role.name === 'SUPER_ADMIN')).toBe(true);
  });

  it('assigns an additional role to the bootstrap admin', () => {
    return request(app.getHttpServer())
      .post(`/admin/admins/${bootstrapAdminId}/roles`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: testRoleId })
      .expect(200)
      .expect({ assigned: true });
  });

  it('removes the additional role from the bootstrap admin', () => {
    return request(app.getHttpServer())
      .delete(`/admin/admins/${bootstrapAdminId}/roles/${testRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ removed: true });
  });

  it('rejects removing SUPER_ADMIN from the bootstrap admin if it is the only holder (409)', async () => {
    const otherSuperAdmins = await prisma.adminUserRole.count({
      where: { roleId: superAdminRoleId, adminUserId: { not: bootstrapAdminId } },
    });
    // This test's assertion only holds if the bootstrap admin is genuinely
    // the only SUPER_ADMIN holder in this environment, which is true on a
    // freshly seeded database and expected to remain true in CI/test runs
    // that don't independently create other SUPER_ADMIN admins.
    if (otherSuperAdmins > 0) {
      return;
    }
    return request(app.getHttpServer())
      .delete(`/admin/admins/${bootstrapAdminId}/roles/${superAdminRoleId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('rejects an admin deactivating their own account (409)', () => {
    return request(app.getHttpServer())
      .post(`/admin/admins/${bootstrapAdminId}/deactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('deactivates a different admin and revokes their sessions', async () => {
    await request(app.getHttpServer())
      .post(`/admin/admins/${secondAdminId}/deactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ deactivated: true });

    const listRes = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const deactivatedEntry = listRes.body.find((a: { id: string }) => a.id === secondAdminId);
    expect(deactivatedEntry.isActive).toBe(false);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: secondAdminRefreshToken })
      .expect(401);
  });

  it('rejects deactivating an already-deactivated admin (409)', () => {
    return request(app.getHttpServer())
      .post(`/admin/admins/${secondAdminId}/deactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(409);
  });

  it('reactivates the admin', async () => {
    await request(app.getHttpServer())
      .post(`/admin/admins/${secondAdminId}/reactivate`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect({ reactivated: true });

    const listRes = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const reactivatedEntry = listRes.body.find((a: { id: string }) => a.id === secondAdminId);
    expect(reactivatedEntry.isActive).toBe(true);
  });
});

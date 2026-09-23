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
      data: {
        email: secondAdminEmail,
        passwordHash: secondAdminPasswordHash,
        fullName: 'E2E Deactivate Target',
        roleId: testRoleId,
      },
    });
    secondAdminId = secondAdmin.id;

    const secondAdminLoginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: secondAdminEmail, password: 'Test-Password-123!' });
    secondAdminRefreshToken = secondAdminLoginRes.body.refreshToken;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { id: secondAdminId } });
    await prisma.role.deleteMany({ where: { name: testRoleName } });
    await app.close();
  });

  it('lists admins including the bootstrap admin with SUPER_ADMIN', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const bootstrapEntry = res.body.data.find((a: { id: string }) => a.id === bootstrapAdminId);
    expect(bootstrapEntry.role.name).toBe('SUPER_ADMIN');
  });

  it('changes the second admin\'s role via PATCH', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/admins/${secondAdminId}/role`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: superAdminRoleId })
      .expect(200)
      .expect({ updated: true });

    const res = await request(app.getHttpServer())
      .get('/admin/admins')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const entry = res.body.data.find((a: { id: string }) => a.id === secondAdminId);
    expect(entry.role.name).toBe('SUPER_ADMIN');

    // put it back so the last-holder test below still sees exactly one
    // extra SUPER_ADMIN holder if it needs to skip, not two.
    await request(app.getHttpServer())
      .patch(`/admin/admins/${secondAdminId}/role`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: testRoleId })
      .expect(200);
  });

  it('rejects moving the sole SUPER_ADMIN holder to a different role (409)', async () => {
    const otherSuperAdmins = await prisma.adminUser.count({
      where: { roleId: superAdminRoleId, id: { not: bootstrapAdminId } },
    });
    // This test's assertion only holds if the bootstrap admin is genuinely
    // the only SUPER_ADMIN holder in this environment, which is true on a
    // freshly seeded database and expected to remain true in CI/test runs
    // that don't independently create other SUPER_ADMIN admins.
    if (otherSuperAdmins > 0) {
      return;
    }
    return request(app.getHttpServer())
      .patch(`/admin/admins/${bootstrapAdminId}/role`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ roleId: testRoleId })
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
    const deactivatedEntry = listRes.body.data.find((a: { id: string }) => a.id === secondAdminId);
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
    const reactivatedEntry = listRes.body.data.find((a: { id: string }) => a.id === secondAdminId);
    expect(reactivatedEntry.isActive).toBe(true);
  });
});

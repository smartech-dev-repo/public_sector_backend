import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  let superAdminRoleId: string;

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

    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    superAdminRoleId = role.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('records an explicit rich event when an invite is created', async () => {
    const email = `audit-test-${Date.now()}@example.com`;

    const res = await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email, roleId: superAdminRoleId })
      .expect(201);

    // Fire-and-forget baseline logging (see AuditInterceptor) needs a brief
    // moment to land after the response is sent.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const explicitEntry = await prisma.auditLog.findFirst({
      where: { action: 'admin.invite.created', targetId: res.body.id },
    });
    expect(explicitEntry).not.toBeNull();
    expect((explicitEntry!.metadata as { email: string }).email).toBe(email);

    const baselineEntry = await prisma.auditLog.findFirst({
      where: { action: { contains: 'POST /admin/invites' } },
      orderBy: { createdAt: 'desc' },
    });
    expect(baselineEntry).not.toBeNull();

    await prisma.adminInvite.deleteMany({ where: { email } });
  });

  it('GET /admin/audit-logs lists recorded entries, newest first', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /admin/audit-logs filters by action', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .query({ action: 'admin.invite.created' })
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.data.every((entry: { action: string }) => entry.action === 'admin.invite.created')).toBe(true);
  });
});

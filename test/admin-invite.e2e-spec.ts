import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin invite (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrapAccessToken: string;
  let superAdminRoleId: string;
  const inviteEmail = 'invited-admin@example.com';

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
    bootstrapAccessToken = loginRes.body.accessToken;

    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'SUPER_ADMIN' } });
    superAdminRoleId = role.id;
  });

  afterAll(async () => {
    await prisma.adminUser.deleteMany({ where: { email: inviteEmail } });
    await prisma.adminInvite.deleteMany({ where: { email: inviteEmail } });
    await app.close();
  });

  it('creates an invite, and the invited admin does not exist yet', async () => {
    await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .send({ email: inviteEmail, roleId: superAdminRoleId })
      .expect(201)
      .expect((res) => {
        expect(res.body.email).toBe(inviteEmail);
        expect(res.body.status).toBe('PENDING');
      });

    const admin = await prisma.adminUser.findUnique({ where: { email: inviteEmail } });
    expect(admin).toBeNull();
  });

  it('rejects accept-invite with a made-up token', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/accept-invite')
      .send({ token: 'not-a-real-token', password: 'invited-password', fullName: 'Invited Admin' })
      .expect(401);
  });

  it('lists the pending invite for the back office', () => {
    return request(app.getHttpServer())
      .get('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.data.some((invite: { email: string }) => invite.email === inviteEmail)).toBe(true);
      });
  });
});

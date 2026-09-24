import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EMAIL_PROVIDERS, EmailMessage } from '../src/email/email-provider.interface';

describe('Admin invite (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bootstrapAccessToken: string;
  let superAdminRoleId: string;
  let capturedEmail: EmailMessage | undefined;
  const inviteEmail = 'invited-admin@example.com';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_PROVIDERS)
      .useValue([
        {
          name: 'test-capture',
          send: async (message: EmailMessage) => {
            capturedEmail = message;
          },
        },
      ])
      .compile();

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
        expect(res.body.role).toEqual({ id: superAdminRoleId, name: 'SUPER_ADMIN' });
      });

    const admin = await prisma.adminUser.findUnique({ where: { email: inviteEmail } });
    expect(admin).toBeNull();
  });

  it('rejects accept-invite with a made-up token', () => {
    return request(app.getHttpServer())
      .post('/auth/admin/accept-invite')
      .send({ token: 'not-a-real-token', password: 'invited-password', firstName: 'Invited', lastName: 'Admin' })
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

  it('lists invites with the full role object hydrated', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(200);
    const listedInvite = res.body.data.find((invite: { email: string }) => invite.email === inviteEmail);
    expect(listedInvite.role.name).toBe('SUPER_ADMIN');
    expect(listedInvite.invitedBy).toEqual(
      expect.objectContaining({ id: expect.any(String), fullName: expect.any(String), email: expect.any(String) }),
    );
  });

  it('creates and then deletes a PENDING invite', async () => {
    const deletableEmail = `deletable-invite-${Date.now()}@example.com`;
    const createRes = await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .send({ email: deletableEmail, roleId: superAdminRoleId })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/admin/invites/${createRes.body.id}`)
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(200)
      .expect({ deleted: true });

    const found = await prisma.adminInvite.findUnique({ where: { id: createRes.body.id } });
    expect(found).toBeNull();
  });

  it('rejects deleting an already-accepted or unknown invite (404)', () => {
    return request(app.getHttpServer())
      .delete('/admin/invites/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .expect(404);
  });

  it('accepts an invite with firstName/lastName and derives fullName', async () => {
    const acceptEmail = `accept-invite-${Date.now()}@example.com`;

    await request(app.getHttpServer())
      .post('/admin/invites')
      .set('Authorization', `Bearer ${bootstrapAccessToken}`)
      .send({ email: acceptEmail, roleId: superAdminRoleId })
      .expect(201);

    const capturedToken = capturedEmail?.text?.match(/accept: (\S+)/)?.[1];
    expect(capturedToken).toBeTruthy();

    const acceptRes = await request(app.getHttpServer())
      .post('/auth/admin/accept-invite')
      .send({ token: capturedToken, password: 'Accepted-Password-123!', firstName: 'Jane', lastName: 'Doe' })
      .expect(200);
    expect(acceptRes.body.accessToken).toEqual(expect.any(String));

    const created = await prisma.adminUser.findUniqueOrThrow({ where: { email: acceptEmail } });
    expect(created.firstName).toBe('Jane');
    expect(created.lastName).toBe('Doe');
    expect(created.fullName).toBe('Jane Doe');

    await prisma.adminUser.deleteMany({ where: { email: acceptEmail } });
    await prisma.adminInvite.deleteMany({ where: { email: acceptEmail } });
  });
});

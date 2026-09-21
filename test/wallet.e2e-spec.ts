import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/auth/token.service';

describe('Wallet (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  let clientId: string;
  let clientAccessToken: string;
  const phone = `+234802${Date.now().toString().slice(-7)}`;

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
    adminAccessToken = loginRes.body.accessToken;

    const client = await prisma.client.create({ data: { phone, status: 'VERIFIED' } });
    clientId = client.id;

    const tokenService = moduleFixture.get(TokenService);
    clientAccessToken = tokenService.signAccessToken({ sub: clientId, type: 'client' });
  });

  afterAll(async () => {
    await prisma.walletEntry.deleteMany({ where: { clientId } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await app.close();
  });

  it('returns a zero balance and empty entries for a client with no wallet history', async () => {
    const res = await request(app.getHttpServer())
      .get('/client/wallet')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .expect(200);

    expect(res.body).toEqual({ balance: 0, entries: [] });
  });

  it('lets an admin credit a client wallet, reflected on both the admin and client views', async () => {
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 5000, description: 'Overpayment excess' })
      .expect(200);

    const adminView = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}/wallet`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(adminView.body.balance).toBe(5000);
    expect(adminView.body.entries).toHaveLength(1);
    expect(adminView.body.entries[0].description).toBe('Overpayment excess');

    const clientView = await request(app.getHttpServer())
      .get('/client/wallet')
      .set('Authorization', `Bearer ${clientAccessToken}`)
      .expect(200);
    expect(clientView.body.balance).toBe(5000);
  });

  it('lets an admin debit within the balance, and rejects a debit beyond it with a 422', async () => {
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/debit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 2000, description: 'Manual correction' })
      .expect(200);

    const afterDebit = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}/wallet`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(afterDebit.body.balance).toBe(3000);

    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/debit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: 999999, description: 'Too much' })
      .expect(422);

    const afterRejectedDebit = await request(app.getHttpServer())
      .get(`/admin/clients/${clientId}/wallet`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(afterRejectedDebit.body.balance).toBe(3000);
  });

  it('rejects an invalid credit body with a 400', async () => {
    await request(app.getHttpServer())
      .post(`/admin/clients/${clientId}/wallet/credit`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ amount: -5, description: '' })
      .expect(400);
  });

  it('returns 404 for a nonexistent client', async () => {
    await request(app.getHttpServer())
      .get('/admin/clients/00000000-0000-0000-0000-000000000000/wallet')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(404);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/client/wallet').expect(401);
  });
});

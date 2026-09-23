import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin agents list endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/admin/login')
      .send({ email: process.env.BOOTSTRAP_ADMIN_EMAIL, password: process.env.BOOTSTRAP_ADMIN_PASSWORD });
    adminAccessToken = loginRes.body.accessToken;

    await prisma.agent.createMany({
      data: [
        { email: 'wave3.agent1@test.com', phone: '08010000001', fullName: 'Wave3 Amaka', address: '1 Test St', status: 'APPROVED', cvKey: 'agents/wave3-test/cv1.pdf' },
        { email: 'wave3.agent2@test.com', phone: '08010000002', fullName: 'Wave3 Bello', address: '2 Test St', status: 'PENDING_REVIEW', cvKey: 'agents/wave3-test/cv2.pdf' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { email: { in: ['wave3.agent1@test.com', 'wave3.agent2@test.com'] } } });
    await app.close();
  });

  it('paginates GET /admin/agents', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/agents by status and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/agents')
      .query({ status: 'APPROVED', q: 'Amaka' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((a: { email: string }) => a.email === 'wave3.agent1@test.com')).toBe(true);
    expect(res.body.data.every((a: { status: string }) => a.status === 'APPROVED')).toBe(true);
  });
});

import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin loan terms list endpoint (e2e)', () => {
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

    await prisma.loanTermOption.createMany({
      data: [
        { agency: 'WAVE3-NPF', tenorMonths: 6, interestRatePercent: 5, managementChargeType: 'PERCENTAGE', managementChargeValue: 2, managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT', isActive: true },
        { agency: 'WAVE3-NPF', tenorMonths: 12, interestRatePercent: 6, managementChargeType: 'PERCENTAGE', managementChargeValue: 2, managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT', isActive: false },
        { agency: 'WAVE3-NSCDC', tenorMonths: 6, interestRatePercent: 5, managementChargeType: 'FLAT', managementChargeValue: 5000, managementChargeApplication: 'ADD_TO_REPAYMENT', isActive: true },
      ],
    });
  });

  afterAll(async () => {
    await prisma.loanTermOption.deleteMany({ where: { agency: { in: ['WAVE3-NPF', 'WAVE3-NSCDC'] } } });
    await app.close();
  });

  it('paginates GET /admin/loan-terms', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-terms?limit=2&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });

  it('filters GET /admin/loan-terms by agency and isActive', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-terms')
      .query({ agency: 'WAVE3-NPF', isActive: 'true' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.every((t: { agency: string; isActive: boolean }) => t.agency === 'WAVE3-NPF' && t.isActive === true)).toBe(true);
    expect(res.body.meta.total).toBe(1);
  });
});

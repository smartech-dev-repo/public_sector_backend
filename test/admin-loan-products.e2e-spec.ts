import * as request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin loan products endpoint (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;
  const productCode = `E2E-PRODUCTS-${Date.now()}`;

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

    await prisma.loanProduct.createMany({
      data: [
        {
          productName: 'Wave 3 NPF Standard',
          productCode: `${productCode}-NPF`,
          sectors: ['NPF'],
          minimumAmount: 1000,
          maximumAmount: 500000,
          minimumTenorMonths: 1,
          maximumTenorMonths: 12,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          isActive: true,
        },
        {
          productName: 'Wave 3 NPF Legacy',
          productCode: `${productCode}-NPF-OLD`,
          sectors: ['NPF'],
          minimumAmount: 1000,
          maximumAmount: 500000,
          minimumTenorMonths: 1,
          maximumTenorMonths: 12,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 6 }],
          managementChargeType: 'PERCENTAGE',
          managementChargeValue: 2,
          managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
          isActive: false,
        },
        {
          productName: 'Wave 3 NSCDC Standard',
          productCode: `${productCode}-NSCDC`,
          sectors: ['NSCDC'],
          minimumAmount: 1000,
          maximumAmount: 500000,
          minimumTenorMonths: 1,
          maximumTenorMonths: 12,
          interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
          managementChargeType: 'FLAT',
          managementChargeValue: 5000,
          managementChargeApplication: 'ADD_TO_REPAYMENT',
          isActive: true,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.loanProduct.deleteMany({ where: { productCode: { startsWith: productCode } } });
    await app.close();
  });

  it('rejects creation with invalid tiers (400)', async () => {
    await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        productName: 'Broken Product',
        productCode: `${productCode}-BROKEN`,
        sectors: ['NPF'],
        minimumAmount: 1000,
        maximumAmount: 500000,
        minimumTenorMonths: 1,
        maximumTenorMonths: 6,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 24, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      })
      .expect(400);
  });

  it('creates a product and rejects a duplicate productCode with a 409', async () => {
    const body = {
      productName: 'Fresh Product',
      productCode: `${productCode}-FRESH`,
      sectors: ['NPF'],
      minimumAmount: 1000,
      maximumAmount: 500000,
      minimumTenorMonths: 1,
      maximumTenorMonths: 12,
      interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
      managementChargeType: 'PERCENTAGE',
      managementChargeValue: 2,
      managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
    };

    await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(body)
      .expect(201);

    await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send(body)
      .expect(409);
  });

  it('paginates GET /admin/loan-products', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-products?limit=2&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });

  it('filters GET /admin/loan-products by sectors and isActive', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-products')
      .query({ sectors: 'NSCDC', isActive: 'true' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(
      res.body.data.every(
        (p: { sectors: string[]; isActive: boolean }) => p.sectors.includes('NSCDC') && p.isActive === true,
      ),
    ).toBe(true);
    expect(res.body.data.some((p: { productCode: string }) => p.productCode === `${productCode}-NSCDC`)).toBe(true);
  });

  it('updates a product', async () => {
    const createRes = await request(app.getHttpServer())
      .post('/admin/loan-products')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({
        productName: 'Updatable Product',
        productCode: `${productCode}-UPDATABLE`,
        sectors: ['NPF'],
        minimumAmount: 1000,
        maximumAmount: 500000,
        minimumTenorMonths: 1,
        maximumTenorMonths: 12,
        interestTiers: [{ minTenorMonths: 1, maxTenorMonths: 12, interestRatePercent: 5 }],
        managementChargeType: 'PERCENTAGE',
        managementChargeValue: 2,
        managementChargeApplication: 'DEDUCT_FROM_DISBURSEMENT',
      })
      .expect(201);

    const updateRes = await request(app.getHttpServer())
      .patch(`/admin/loan-products/${createRes.body.id}`)
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .send({ isActive: false })
      .expect(200);
    expect(updateRes.body.isActive).toBe(false);
  });

  it('returns the known agencies from the sectors endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loan-products/sectors')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.sectors).toEqual(['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG']);
  });
});

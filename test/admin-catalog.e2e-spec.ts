import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Admin catalog list endpoints (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccessToken: string;

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

    await prisma.ippisRecord.createMany({
      data: [
        { agency: 'NPF', staffId: 'CAT-001', employeeName: 'Amaka Test', employeeStatus: 'ACTIVE', department: 'Finance', grade: 'GL-08', hireDate: new Date('2015-06-01') },
        { agency: 'NPF', staffId: 'CAT-002', employeeName: 'Bello Test', employeeStatus: 'RETIRED', department: 'Operations', grade: 'GL-12', hireDate: new Date('2005-03-01') },
      ],
    });
    await prisma.loan.createMany({
      data: [
        {
          customerId: 'cat-loan-001', customerName: 'Amaka Test', accountNumber: '1000000001', ippisNumber: 'CAT-001',
          agency: 'NPF', loanAmount: 100000, principalBalance: 50000, disbursementDate: new Date('2025-01-01'),
          maturationDate: new Date('2026-01-01'), product: 'Salary Advance', interestRatePercent: 5,
        },
        {
          customerId: 'cat-loan-002', customerName: 'Bello Test', accountNumber: '1000000002', ippisNumber: 'CAT-002',
          agency: 'NSCDC', loanAmount: 200000, principalBalance: 100000, disbursementDate: new Date('2025-06-01'),
          maturationDate: new Date('2026-06-01'), product: 'Consolidation', interestRatePercent: 5,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.loan.deleteMany({ where: { customerId: { in: ['cat-loan-001', 'cat-loan-002'] } } });
    await prisma.ippisRecord.deleteMany({ where: { staffId: { in: ['CAT-001', 'CAT-002'] } } });
    await app.close();
  });

  it('paginates GET /admin/ippis-records', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/ippis-records?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/ippis-records by employeeStatus and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/ippis-records')
      .query({ employeeStatus: 'ACTIVE', q: 'Amaka' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((r: { staffId: string }) => r.staffId === 'CAT-001')).toBe(true);
    expect(res.body.data.every((r: { employeeStatus: string }) => r.employeeStatus === 'ACTIVE')).toBe(true);
  });

  it('paginates GET /admin/loans', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loans?limit=1&page=1')
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(1);
    expect(res.body.meta.limit).toBe(1);
  });

  it('filters GET /admin/loans by agency and searches by q', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/loans')
      .query({ agency: 'NSCDC', q: 'Bello' })
      .set('Authorization', `Bearer ${adminAccessToken}`)
      .expect(200);
    expect(res.body.data.some((l: { customerId: string }) => l.customerId === 'cat-loan-002')).toBe(true);
    expect(res.body.data.every((l: { agency: string }) => l.agency === 'NSCDC')).toBe(true);
  });
});

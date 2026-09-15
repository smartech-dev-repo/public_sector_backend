import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function waitForBatchCompletion(prisma: PrismaService, batchId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const batch = await prisma.documentUploadBatch.findUnique({ where: { id: batchId } });
    if (batch && (batch.status === 'COMPLETED' || batch.status === 'FAILED')) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Batch ${batchId} did not finish within ${timeoutMs}ms`);
}

describe('Document uploads (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const createdBatchIds: string[] = [];

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
  });

  afterAll(async () => {
    // Guarded so a beforeAll failure (e.g. a module wiring bug) still lets
    // the app close and release its BullMQ/Redis connections, rather than
    // leaving the process dangling after Jest has already reported results.
    if (prisma) {
      await prisma.documentUploadBatch.deleteMany({ where: { id: { in: createdBatchIds } } });
    }
    if (app) {
      await app.close();
    }
  });

  it('uploads an IPPIS broadsheet file, processes it via the no-op parser, and completes', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/documents/ippis-broadsheet/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('fake-xlsx-content'), 'broadsheet.xlsx')
      .expect(201);

    expect(res.body.documentType).toBe('IPPIS_BROADSHEET');
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(0);
  });

  it('rejects an unauthenticated upload', () => {
    return request(app.getHttpServer())
      .post('/admin/documents/disbursed-loans/upload')
      .attach('file', Buffer.from('fake'), 'loans.xlsx')
      .expect(401);
  });

  it('rejects a repayment-schedule upload with no period', () => {
    return request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('fake'), 'repayments.xlsx')
      .expect(400);
  });

  it('accepts a repayment-schedule upload with a valid period and records it on the batch', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-12')
      .attach('file', Buffer.from('fake'), 'repayments.xlsx')
      .expect(201);
    createdBatchIds.push(res.body.id);

    const batch = await waitForBatchCompletion(prisma, res.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.period).toBe('2024-12');
  });

  it('lists batches and fetches one by id', async () => {
    const listRes = await request(app.getHttpServer())
      .get('/admin/documents/batches')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThan(0);

    const batchId = listRes.body[0].id;
    const detailRes = await request(app.getHttpServer())
      .get(`/admin/documents/batches/${batchId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(detailRes.body.id).toBe(batchId);
  });
});

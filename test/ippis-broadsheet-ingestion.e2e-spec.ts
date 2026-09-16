import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function buildBroadsheetBuffer(staffId: string, bvn: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('NPF');
  sheet.addRow(['Staff ID', 'Employee Name', 'Employee Status', 'Bvn']);
  sheet.addRow([staffId, 'E2E Test Employee', 'Active', bvn]);
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

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

describe('IPPIS broadsheet ingestion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const staffId = `E2E-STAFF-${Date.now()}`;
  const bvn = 20000000000 + Math.floor(Math.random() * 999999999);

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
    if (prisma) {
      await prisma.ippisRecord.deleteMany({ where: { staffId } });
    }
    if (app) {
      await app.close();
    }
  });

  it('parses an uploaded broadsheet into an IppisRecord and creates a snapshot export', async () => {
    const buffer = await buildBroadsheetBuffer(staffId, bvn);

    const uploadRes = await request(app.getHttpServer())
      .post('/admin/documents/ippis-broadsheet/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', buffer, 'broadsheet.xlsx')
      .expect(201);

    const batch = await waitForBatchCompletion(prisma, uploadRes.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(1);
    expect(batch!.rowsCreated).toBe(1);
    expect(batch!.snapshotExportId).not.toBeNull();

    const record = await prisma.ippisRecord.findUnique({ where: { agency_staffId: { agency: 'NPF', staffId } } });
    expect(record).not.toBeNull();
    expect(record!.employeeName).toBe('E2E Test Employee');
    expect(record!.bvn).toBe(String(bvn));
  });
});

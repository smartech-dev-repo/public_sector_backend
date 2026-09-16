import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const REAL_HEADERS = [
  'Customer ID', 'Customer Name', 'Account No.', 'Loan Amount', 'Principal Bal.',
  'Disbursement Date', 'Maturation Date', 'Product', 'Interest Rate', 'IPPIS',
];

async function buildLoansBuffer(customerId: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRow(['TEST BANK']);
  sheet.addRow(['Title:', 'Disbursed Loans Report']);
  sheet.addRow([]);
  sheet.addRow(REAL_HEADERS);
  sheet.addRow([
    customerId, 'E2E Test Customer', 'ACC-E2E-1', 500000, 0,
    '08-Aug-2024', '30-May-2026', 'TEST PRODUCT', 42, 'CD7038686',
  ]);
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

describe('Disbursed loans ingestion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const customerId = `E2E-CUST-${Date.now()}`;

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
      await prisma.loan.deleteMany({ where: { customerId } });
    }
    if (app) {
      await app.close();
    }
  });

  it('parses an uploaded disbursed-loans report into a Loan and creates a snapshot export', async () => {
    const buffer = await buildLoansBuffer(customerId);

    const uploadRes = await request(app.getHttpServer())
      .post('/admin/documents/disbursed-loans/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', buffer, 'loans.xlsx')
      .expect(201);

    const batch = await waitForBatchCompletion(prisma, uploadRes.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(1);
    expect(batch!.rowsCreated).toBe(1);
    expect(batch!.snapshotExportId).not.toBeNull();

    const loan = await prisma.loan.findUnique({ where: { customerId } });
    expect(loan).not.toBeNull();
    expect(loan!.customerName).toBe('E2E Test Customer');
    expect(loan!.agency).toBe('NSCDC');
  });
});

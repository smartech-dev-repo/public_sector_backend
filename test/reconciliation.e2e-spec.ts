import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const LOAN_HEADERS = [
  'Customer ID', 'Customer Name', 'Account No.', 'Loan Amount', 'Principal Bal.',
  'Disbursement Date', 'Maturation Date', 'Product', 'Interest Rate', 'IPPIS',
];

async function buildLoanBuffer(customerId: string, ippisNumber: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRow(['TEST BANK']);
  sheet.addRow(['Title:', 'Disbursed Loans Report']);
  sheet.addRow([]);
  sheet.addRow(LOAN_HEADERS);
  sheet.addRow([
    customerId, 'E2E Reconciliation Customer', 'ACC-E2E-RECON', 100000, 100000,
    '01-Jan-2025', '01-Feb-2025', 'TEST PRODUCT', 12, ippisNumber,
  ]);
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

async function buildRepaymentScheduleBuffer(ippisNumber: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const nscdcSheet = workbook.addWorksheet('NSCDC');
  nscdcSheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
  nscdcSheet.addRow(['E2E Reconciliation Customer', ippisNumber, 101000]);
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

describe('Reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const customerId = `E2E-RECON-CUST-${Date.now()}`;
  const ippisNumber = `CD-E2E-RECON-${Date.now()}`;

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
    const loan = await prisma.loan.findUnique({ where: { customerId } });
    if (loan) {
      await prisma.repaymentVariance.deleteMany({ where: { loanId: loan.id } });
    }
    await prisma.loan.deleteMany({ where: { customerId } });
    await prisma.loanRepaymentRecord.deleteMany({ where: { staffId: ippisNumber } });
    await app.close();
  });

  it(
    'reconciles a matching loan and repayment record after both uploads complete',
    async () => {
      const loanBuffer = await buildLoanBuffer(customerId, ippisNumber);
      const loanUploadRes = await request(app.getHttpServer())
        .post('/admin/documents/disbursed-loans/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .attach('file', loanBuffer, 'loans.xlsx')
        .expect(201);
      await waitForBatchCompletion(prisma, loanUploadRes.body.id);

      const repaymentBuffer = await buildRepaymentScheduleBuffer(ippisNumber);
      const repaymentUploadRes = await request(app.getHttpServer())
        .post('/admin/documents/repayment-schedule/upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .field('period', '2025-01')
        .attach('file', repaymentBuffer, 'repayments.xlsx')
        .expect(201);
      const repaymentBatch = await waitForBatchCompletion(prisma, repaymentUploadRes.body.id);
      expect(repaymentBatch!.status).toBe('COMPLETED');

      const listRes = await request(app.getHttpServer())
        .get('/admin/reconciliation')
        .query({ agency: 'NSCDC', period: '2025-01' })
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const variance = listRes.body.find(
        (v: { loan: { customerId: string } }) => v.loan.customerId === customerId,
      );
      expect(variance).toBeDefined();
      expect(variance.status).toBe('MATCHED');
      expect(Number(variance.expectedAmount)).toBeCloseTo(101000, 2);
      expect(Number(variance.actualAmount)).toBe(101000);
    },
    30000,
  );
});

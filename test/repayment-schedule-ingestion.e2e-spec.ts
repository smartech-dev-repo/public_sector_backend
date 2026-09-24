import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as ExcelJS from 'exceljs';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function buildRepaymentScheduleBuffer(staffId: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  const npfSheet = workbook.addWorksheet('NPF');
  npfSheet.addRow(['Staff ID', 'Amount', 'Element', 'Period']);
  npfSheet.addRow([staffId, 5000, 'PERSONAL LOAN', 'NOVEMBER 2024']);

  const nscdcSheet = workbook.addWorksheet('NSCDC');
  nscdcSheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
  nscdcSheet.addRow(['E2E NSCDC Staff', `${staffId}-NSCDC`, 3000]);

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

describe('Repayment schedule ingestion (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let accessToken: string;
  const staffId = `E2E-STAFF-${Date.now()}`;

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
      await prisma.loanRepaymentRecord.deleteMany({ where: { staffId: { in: [staffId, `${staffId}-NSCDC`] } } });
    }
    if (app) {
      await app.close();
    }
  });

  it('parses an uploaded repayment schedule into LoanRepaymentRecord rows across two agency sheets', async () => {
    const buffer = await buildRepaymentScheduleBuffer(staffId);

    const uploadRes = await request(app.getHttpServer())
      .post('/admin/documents/repayment-schedule/upload')
      .set('Authorization', `Bearer ${accessToken}`)
      .field('period', '2024-11')
      .attach('file', buffer, 'repayments.xlsx')
      .expect(201);

    const batch = await waitForBatchCompletion(prisma, uploadRes.body.id);
    expect(batch!.status).toBe('COMPLETED');
    expect(batch!.rowsProcessed).toBe(2);
    expect(batch!.rowsCreated).toBe(2);
    expect(batch!.snapshotExportId).not.toBeNull();

    const npfRecord = await prisma.loanRepaymentRecord.findUnique({
      where: {
        agency_staffId_period_elementName: {
          agency: 'NPF',
          staffId,
          period: '2024-11',
          elementName: 'PERSONAL LOAN',
        },
      },
    });
    expect(npfRecord).not.toBeNull();
    expect(Number(npfRecord!.amount)).toBe(5000);

    const nscdcRecord = await prisma.loanRepaymentRecord.findUnique({
      where: {
        agency_staffId_period_elementName: {
          agency: 'NSCDC',
          staffId: `${staffId}-NSCDC`,
          period: '2024-11',
          elementName: 'LOAN_REPAYMENT',
        },
      },
    });
    expect(nscdcRecord).not.toBeNull();
    expect(Number(nscdcRecord!.amount)).toBe(3000);
  }, 20000);
});

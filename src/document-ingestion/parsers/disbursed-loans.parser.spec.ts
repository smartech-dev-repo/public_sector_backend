import * as ExcelJS from 'exceljs';
import { DisbursedLoansParser } from './disbursed-loans.parser';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentUploadBatch } from '../../generated/prisma/client';

const REAL_HEADERS = [
  'Customer ID', 'Customer Name', 'Group Name', 'Account No.', 'Address', 'Branch', 'Gender',
  'Phone No.', 'Ministries, Departments and Agencies', 'Loan Amount', 'Principal Bal.',
  'Disbursement Date', 'Maturation Date', 'Effective Date', 'Moratarium (day)', 'Product',
  'Linked Account Number', 'BVN', 'Interest Rate', 'Account Officer',
  'Has Previously Taken Loan', 'IPPIS',
];

async function buildWorkbook(filterRowCount: number, dataRows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Report');
  sheet.addRow(['TEST BANK']);
  for (let i = 0; i < filterRowCount; i++) {
    sheet.addRow([`Filter ${i}:`, 'All']);
  }
  sheet.addRow([]);
  sheet.addRow(REAL_HEADERS);
  dataRows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

function fullDataRow(overrides: Partial<Record<string, unknown>> = {}): unknown[] {
  const base: Record<string, unknown> = {
    'Customer ID': 'CUST-1',
    'Customer Name': 'TEST CUSTOMER',
    'Group Name': '',
    'Account No.': 'ACC-1',
    Address: 'TEST ADDRESS',
    Branch: 'Head Office',
    Gender: 'Male',
    'Phone No.': '08000000000',
    'Ministries, Departments and Agencies': '',
    'Loan Amount': 500000,
    'Principal Bal.': 0,
    'Disbursement Date': '08-Aug-2024',
    'Maturation Date': '30-May-2026',
    'Effective Date': '07-Oct-2024',
    'Moratarium (day)': '60',
    Product: 'TEST PRODUCT',
    'Linked Account Number': 'LINKED-1',
    BVN: '22209498402',
    'Interest Rate': 42,
    'Account Officer': 'TEST OFFICER',
    'Has Previously Taken Loan': 1,
    IPPIS: 'CD7038686',
  };
  return REAL_HEADERS.map((header) => overrides[header] ?? base[header]);
}

describe('DisbursedLoansParser', () => {
  let parser: DisbursedLoansParser;
  let prisma: { loan: { findMany: jest.Mock; upsert: jest.Mock } };
  let snapshotExportService: { exportSnapshot: jest.Mock };

  beforeEach(() => {
    prisma = { loan: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) } };
    snapshotExportService = { exportSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }) };
    parser = new DisbursedLoansParser(
      prisma as unknown as PrismaService,
      snapshotExportService as unknown as SnapshotExportService,
    );
  });

  it('locates the header row after a 7-row filter block (matching the real file) and upserts a new loan', async () => {
    const buffer = await buildWorkbook(7, [fullDataRow()]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    expect(prisma.loan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'CUST-1' },
        create: expect.objectContaining({ customerId: 'CUST-1', agency: 'NSCDC' }),
      }),
    );
  });

  it('locates the header row after a differently-sized filter block', async () => {
    const buffer = await buildWorkbook(2, [fullDataRow()]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);
    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('fails the whole batch if no header row is found in the first 20 rows', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Report');
    for (let i = 0; i < 25; i++) sheet.addRow(['not a header row']);
    const buffer = (await workbook.xlsx.writeBuffer()) as unknown as Buffer;

    await expect(parser.parse({} as DocumentUploadBatch, buffer)).rejects.toThrow(/header row/i);
  });

  it('counts an existing customerId as an update, not a create', async () => {
    prisma.loan.findMany.mockResolvedValue([{ customerId: 'CUST-1' }]);
    const buffer = await buildWorkbook(7, [fullDataRow()]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);
    expect(result.rowsCreated).toBe(0);
    expect(result.rowsUpdated).toBe(1);
  });

  it('skips an invalid row (missing Customer ID) but still processes the rest', async () => {
    const buffer = await buildWorkbook(7, [
      fullDataRow({ 'Customer ID': '' }),
      fullDataRow({ 'Customer ID': 'CUST-2' }),
    ]);
    const result = await parser.parse({} as DocumentUploadBatch, buffer);
    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('calls exportSnapshot with the current Loan table before upserting', async () => {
    prisma.loan.findMany.mockResolvedValue([
      { id: 'l1', customerId: 'CUST-9', rawFields: { 'group name': 'X' } },
    ]);
    const buffer = await buildWorkbook(7, []);

    await parser.parse({} as DocumentUploadBatch, buffer);

    expect(snapshotExportService.exportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'DISBURSED_LOANS',
        tableName: 'Loan',
        rows: [expect.objectContaining({ id: 'l1', rawFields: JSON.stringify({ 'group name': 'X' }) })],
      }),
    );
  });
});

import * as ExcelJS from 'exceljs';
import { RepaymentScheduleParser } from './repayment-schedule.parser';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentUploadBatch } from '../../generated/prisma/client';

async function buildWorkbook(builder: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  builder(workbook);
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

function batchWithPeriod(period: string | null): DocumentUploadBatch {
  return { period } as DocumentUploadBatch;
}

describe('RepaymentScheduleParser', () => {
  let parser: RepaymentScheduleParser;
  let prisma: { loanRepaymentRecord: { findMany: jest.Mock; upsert: jest.Mock } };
  let snapshotExportService: { exportSnapshot: jest.Mock };

  beforeEach(() => {
    prisma = {
      loanRepaymentRecord: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
    };
    snapshotExportService = { exportSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }) };
    parser = new RepaymentScheduleParser(
      prisma as unknown as PrismaService,
      snapshotExportService as unknown as SnapshotExportService,
    );
  });

  it('parses an NPF row using its own period, ignoring the upload period when they match', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NPF');
      sheet.addRow(['Staff ID', 'Amount', 'Element', 'Period']);
      sheet.addRow(['NPF/1', 5000, 'PERSONAL LOAN', 'SEPTEMBER 2024']);
    });

    const result = await parser.parse(batchWithPeriod('2024-09'), buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(prisma.loanRepaymentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agency_staffId_period_elementName: { agency: 'NPF', staffId: 'NPF/1', period: '2024-09', elementName: 'PERSONAL LOAN' } },
      }),
    );
  });

  it("warns but still ingests under the row's own period when it does not match the upload period", async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NPF');
      sheet.addRow(['Staff ID', 'Amount', 'Element', 'Period']);
      sheet.addRow(['NPF/1', 5000, 'PERSONAL LOAN', 'SEPTEMBER 2024']);
    });

    const result = await parser.parse(batchWithPeriod('2024-10'), buffer);

    expect(result.rowsCreated).toBe(1);
    expect(result.warnings.some((w) => w.includes('does not match'))).toBe(true);
    expect(prisma.loanRepaymentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agency_staffId_period_elementName: expect.objectContaining({ period: '2024-09' }) }),
      }),
    );
  });

  it('falls back to the upload period for a sheet with no period column', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['TEST STAFF', 'CD1', 3000]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsCreated).toBe(1);
    expect(prisma.loanRepaymentRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ agency_staffId_period_elementName: expect.objectContaining({ period: '2024-11' }) }),
      }),
    );
  });

  it('locates the LASG header row at row 3 (after a 2-row title block)', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('LASG');
      sheet.addRow(['SOME TITLE TEXT']);
      sheet.addRow([]);
      sheet.addRow(['Employee_Number', 'Employee_Name', 'Result_Value SUM']);
      sheet.addRow(['LASG-1', 'TEST STAFF', 2500]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('skips an unrecognized sheet with a warning and does not fail the batch', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('SomeOtherAgency');
      sheet.addRow(['Staff ID', 'Amount']);
      sheet.addRow(['X/1', 100]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(0);
    expect(result.warnings.some((w) => w.includes('SomeOtherAgency'))).toBe(true);
  });

  it('skips an invalid row but still processes the rest of the sheet', async () => {
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['BAD ROW', '', 100]);
      sheet.addRow(['GOOD ROW', 'CD2', 200]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
  });

  it('counts an existing natural key as an update, not a create', async () => {
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { agency: 'NSCDC', staffId: 'CD1', period: '2024-11', elementName: 'LOAN_REPAYMENT' },
    ]);
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['TEST STAFF', 'CD1', 3000]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsCreated).toBe(0);
    expect(result.rowsUpdated).toBe(1);
  });

  it('recovers from a per-row exception without failing the rest of the sheet', async () => {
    prisma.loanRepaymentRecord.upsert
      .mockRejectedValueOnce(new Error('simulated DB error'))
      .mockResolvedValue({});
    const buffer = await buildWorkbook((wb) => {
      const sheet = wb.addWorksheet('NSCDC');
      sheet.addRow(['Employee Name', 'IPPIS NO', 'Amount']);
      sheet.addRow(['FIRST', 'CD1', 100]);
      sheet.addRow(['SECOND', 'CD2', 200]);
    });

    const result = await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.warnings.some((w) => w.includes('simulated DB error'))).toBe(true);
  });

  it('calls exportSnapshot with the current LoanRepaymentRecord table before upserting', async () => {
    prisma.loanRepaymentRecord.findMany.mockResolvedValue([
      { id: 'r1', agency: 'NPF', staffId: 'NPF/1', rawFields: { check: 'OK' } },
    ]);
    const buffer = await buildWorkbook((wb) => {
      wb.addWorksheet('NPF');
    });

    await parser.parse(batchWithPeriod('2024-11'), buffer);

    expect(snapshotExportService.exportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'REPAYMENT_SCHEDULE',
        tableName: 'LoanRepaymentRecord',
        rows: [expect.objectContaining({ id: 'r1', rawFields: JSON.stringify({ check: 'OK' }) })],
      }),
    );
  });
});

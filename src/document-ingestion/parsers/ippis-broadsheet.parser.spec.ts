import * as ExcelJS from 'exceljs';
import { IppisBroadsheetParser } from './ippis-broadsheet.parser';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentUploadBatch } from '../../generated/prisma/client';

async function buildWorkbook(sheets: Record<string, { headers: string[]; rows: unknown[][] }>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [sheetName, { headers, rows }] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(headers);
    rows.forEach((row) => sheet.addRow(row));
  }
  return workbook.xlsx.writeBuffer() as unknown as Buffer;
}

describe('IppisBroadsheetParser', () => {
  let parser: IppisBroadsheetParser;
  let prisma: { ippisRecord: { findMany: jest.Mock; upsert: jest.Mock } };
  let snapshotExportService: { exportSnapshot: jest.Mock };

  beforeEach(() => {
    prisma = {
      ippisRecord: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn().mockResolvedValue({}) },
    };
    snapshotExportService = { exportSnapshot: jest.fn().mockResolvedValue({ id: 'snap-1' }) };
    parser = new IppisBroadsheetParser(
      prisma as unknown as PrismaService,
      snapshotExportService as unknown as SnapshotExportService,
    );
  });

  const NPF_HEADERS = ['Staff ID', 'Employee Name', 'Employee Status', 'Bvn'];

  it('parses rows from a recognized agency sheet and upserts each as a new record', async () => {
    const buffer = await buildWorkbook({
      NPF: { headers: NPF_HEADERS, rows: [['NPF/1', 'Jane Doe', 'Active', 22345678901]] },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.rowsUpdated).toBe(0);
    expect(result.rowsSkipped).toBe(0);
    expect(result.snapshotExportId).toBe('snap-1');
    expect(prisma.ippisRecord.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agency_staffId: { agency: 'NPF', staffId: 'NPF/1' } },
        create: expect.objectContaining({ agency: 'NPF', staffId: 'NPF/1', employeeName: 'Jane Doe' }),
      }),
    );
  });

  it('counts an existing (agency, staffId) as an update, not a create', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([{ agency: 'NPF', staffId: 'NPF/1' }]);
    const buffer = await buildWorkbook({
      NPF: { headers: NPF_HEADERS, rows: [['NPF/1', 'Jane Doe', 'Active', 22345678901]] },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsCreated).toBe(0);
    expect(result.rowsUpdated).toBe(1);
  });

  it('skips an unrecognized sheet with a warning and does not fail the batch', async () => {
    const buffer = await buildWorkbook({
      SomeOtherAgency: { headers: NPF_HEADERS, rows: [['X/1', 'John Doe', 'Active', 22345678901]] },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(0);
    expect(prisma.ippisRecord.upsert).not.toHaveBeenCalled();
    expect(result.warnings.some((w) => w.includes('SomeOtherAgency'))).toBe(true);
  });

  it('skips an invalid row (bad BVN) but still processes the rest of the sheet', async () => {
    const buffer = await buildWorkbook({
      NPF: {
        headers: NPF_HEADERS,
        rows: [
          ['NPF/1', 'Jane Doe', 'Active', 123],
          ['NPF/2', 'John Smith', 'Active', 22345678902],
        ],
      },
    });

    const result = await parser.parse({} as DocumentUploadBatch, buffer);

    expect(result.rowsProcessed).toBe(2);
    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsCreated).toBe(1);
    expect(result.warnings.some((w) => w.includes('BVN'))).toBe(true);
  });

  it('calls exportSnapshot with the current IppisRecord table before upserting', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([
      { id: 'r1', agency: 'NPF', staffId: 'NPF/9', rawFields: { 'email address': 'x@example.com' } },
    ]);
    const buffer = await buildWorkbook({ NPF: { headers: NPF_HEADERS, rows: [] } });

    await parser.parse({} as DocumentUploadBatch, buffer);

    expect(snapshotExportService.exportSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'IPPIS_BROADSHEET',
        tableName: 'IppisRecord',
        rows: [expect.objectContaining({ id: 'r1', rawFields: JSON.stringify({ 'email address': 'x@example.com' }) })],
      }),
    );
  });
});

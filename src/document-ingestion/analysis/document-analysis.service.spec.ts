import { SectorService } from '../../sectors/sector.service';
import * as ExcelJS from 'exceljs';
import { DocumentAnalysisService } from './document-analysis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType, DocumentUploadBatch } from '../../generated/prisma/client';
import { buildTemplateWorkbook } from '../document-templates';
import { loadUploadedWorkbook } from '../parsers/load-uploaded-workbook';
import { IPPIS_KNOWN_HEADERS } from '../parsers/ippis-row-mapper';

const HEADERS = ['Staff ID', 'Employee Name', ...Object.keys(IPPIS_KNOWN_HEADERS).slice(2)];

async function workbookBuffer(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name);
    rows.forEach((row) => sheet.addRow(row));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function ippisRow(staffId: unknown, name: unknown, overrides: Record<string, unknown> = {}): unknown[] {
  const values: Record<string, unknown> = { 'telephone number': `80${String(staffId).padStart(8, '0')}`, ...overrides };
  return HEADERS.map((header, index) => (index === 0 ? staffId : index === 1 ? name : (values[header] ?? null)));
}

describe('DocumentAnalysisService', () => {
  let prisma: {
    ippisRecord: { findMany: jest.Mock };
    clientOnboarding: { findMany: jest.Mock };
    loanRepaymentRecord: { findMany: jest.Mock };
    loan: { findMany: jest.Mock };
  };
  let service: DocumentAnalysisService;
  const batch = (documentType: DocumentType, period: string | null = null) =>
    ({ documentType, period }) as DocumentUploadBatch;

  beforeEach(() => {
    prisma = {
      ippisRecord: { findMany: jest.fn().mockResolvedValue([]) },
      clientOnboarding: { findMany: jest.fn().mockResolvedValue([]) },
      loanRepaymentRecord: { findMany: jest.fn().mockResolvedValue([]) },
      loan: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new DocumentAnalysisService(
      prisma as unknown as PrismaService,
      { codes: jest.fn().mockResolvedValue(['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOMS', 'LASG']) } as unknown as SectorService,
    );
  });

  it('requires a reupload for a file that is not a workbook', async () => {
    const result = await service.analyze(batch(DocumentType.IPPIS_BROADSHEET), Buffer.from('staff id,name\n1,x'));
    expect(result.verdict).toBe('REUPLOAD_REQUIRED');
    expect(result.canMerge).toBe(false);
  });

  it('requires a reupload when no agency sheet is recognized', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ Sheet1: [HEADERS, ippisRow(1, 'A')] }),
    );
    expect(result.verdict).toBe('REUPLOAD_REQUIRED');
  });

  it('names a sheet whose sector is not set up, and keeps its rows out of the merge', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A')], FRSC: [HEADERS, ippisRow(2, 'B')] }),
    );
    expect(result.unknownSectors).toEqual([{ sheet: 'FRSC', rows: 1, likelyTypoOf: null }]);
    expect(result.validRows).toBe(1);
    expect(result.canMerge).toBe(true);
  });

  it('never tells the reviewer every row can be merged when a sheet is left out', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A')], FRSC: [HEADERS, ippisRow(2, 'B'), ippisRow(3, 'C')] }),
    );
    expect(result.verdict).toBe('MERGE_WITH_CORRECTIONS');
    expect(result.recommendation).toContain('2 rows on the sheets listed above will also be left out');
    expect(result.issueGroups).toEqual([]);
  });

  it('flags a default-named sheet holding data, but not a notes sheet', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A')], Notes: [['Prepared by'], ['Finance']], Sheet1: [HEADERS, ippisRow(2, 'B')] }),
    );
    expect(result.unknownSectors).toEqual([{ sheet: 'Sheet1', rows: 1, likelyTypoOf: null }]);
  });

  it('suggests the likely sector for a typo', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A')], NFP: [HEADERS, ippisRow(2, 'B')] }),
    );
    expect(result.unknownSectors).toEqual([{ sheet: 'NFP', rows: 1, likelyTypoOf: 'NPF' }]);
    expect(JSON.stringify(result.issues)).toContain('looks like a typo of');
  });

  it('counts creates and updates and passes a clean broadsheet', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([{ agency: 'NPF', staffId: '1' }]);
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A'), ippisRow(2, 'B')] }),
    );
    expect(result).toEqual(
      expect.objectContaining({ verdict: 'READY', severity: 'CLEAN', rowsToCreate: 1, rowsToUpdate: 1, rowsToSkip: 0 }),
    );
  });

  it('allows a merge with corrections when a minority of rows are rejected, and masks the BVN', async () => {
    const rows = [HEADERS, ...Array.from({ length: 9 }, (_, i) => ippisRow(i + 1, `S${i}`)), ippisRow(10, 'Bad', { bvn: '123456789012' })];
    const result = await service.analyze(batch(DocumentType.IPPIS_BROADSHEET), await workbookBuffer({ NPF: rows }));

    expect(result.verdict).toBe('MERGE_WITH_CORRECTIONS');
    expect(result.severity).toBe('MODERATE');
    expect(result.rowsToSkip).toBe(1);
    expect(JSON.stringify(result)).not.toContain('123456789012');
    expect(result.issueGroups[0]).toEqual(expect.objectContaining({ severity: 'ERROR', count: 1 }));
  });

  it('requires a reupload when half the rows would be rejected', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A'), ippisRow(2, null)] }),
    );
    expect(result.verdict).toBe('REUPLOAD_REQUIRED');
  });

  it('warns on rows onboarding cannot use: missing and malformed phones', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({
        NPF: [
          HEADERS,
          ippisRow(1, 'A'),
          ippisRow(2, 'B', { 'telephone number': '123' }),
          ippisRow(3, 'C', { 'telephone number': null }),
        ],
      }),
    );
    expect(result.verdict).toBe('MERGE_WITH_CORRECTIONS');
    expect(result.rowsWithWarnings).toBe(2);
    expect(result.rowsToSkip).toBe(0);
  });

  it('rejects a row whose phone is used by another row, record or registered client', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([{ agency: 'NPF', staffId: 'OLD', phone: '08050000001' }]);
    prisma.clientOnboarding.findMany.mockResolvedValue([
      { client: { phone: '+2348050000002' }, ippisRecord: { agency: 'NPF', staffId: 'REGISTERED' } },
    ]);
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({
        NPF: [
          HEADERS,
          ippisRow(1, 'A', { 'telephone number': '8000000001' }),
          ippisRow(2, 'B', { 'telephone number': '08000000001' }),
          ippisRow(3, 'C', { 'telephone number': '8050000001' }),
          ippisRow(4, 'D', { 'telephone number': '+2348050000002' }),
          ippisRow(5, 'E', { 'telephone number': '8000000005' }),
        ],
      }),
    );
    expect(result.validRows).toBe(2);
    expect(result.rowsToSkip).toBe(3);
    expect(result.issueGroups[0]).toMatchObject({ severity: 'ERROR', count: 3 });
  });

  it('warns on an unusable month payment', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A', { 'payment 3 months ago': 'n/a' })] }),
    );
    expect(result.issues[0].message).toContain('payment 3 months ago');
  });

  it('reads a CSV as the agency chosen at upload and keeps leading zeros', async () => {
    const csv = Buffer.from('\ufeffStaff ID,Employee Name,Account Number,Telephone Number\n0012,Ada,0123456789,08031112222\n');
    const csvBatch = { documentType: DocumentType.IPPIS_BROADSHEET, originalFileName: 'x.csv', sheetName: 'NSCDC' } as DocumentUploadBatch;

    const result = await service.analyze(csvBatch, csv);

    expect(result.sheets).toEqual([{ name: 'NSCDC', recognized: true, rows: 1, validRows: 1 }]);
    const workbook = await loadUploadedWorkbook(csvBatch, csv);
    expect(workbook.worksheets[0].getRow(2).values).toEqual(expect.arrayContaining(['0012', '0123456789', '08031112222']));
  });

  it('names the rows to check on each issue group', async () => {
    const result = await service.analyze(
      batch(DocumentType.IPPIS_BROADSHEET),
      await workbookBuffer({ NPF: [HEADERS, ippisRow(1, 'A'), ippisRow(2, 'B'), ippisRow(3, 'C', { 'telephone number': '123' })] }),
    );
    expect(result.issueGroups[0].locations).toEqual(['NPF row 4']);
  });

  it('flags repayment rows outside the upload month or off the payroll', async () => {
    prisma.ippisRecord.findMany.mockResolvedValue([{ agency: 'NPF', staffId: 'PF1' }]);
    const result = await service.analyze(
      batch(DocumentType.REPAYMENT_SCHEDULE, '2026-10'),
      await workbookBuffer({
        NPF: [
          ['Staff ID', 'Amount', 'Element', 'Period'],
          ['PF1', 100, 'LOAN', '2026-10'],
          ['PF1', 100, 'LOAN2', '2026-09'],
          ['PF9', 100, 'LOAN', '2026-10'],
        ],
      }),
    );
    expect(result.validRows).toBe(3);
    expect(result.rowsWithWarnings).toBe(2);
  });

  it('reads the same columns on every sector sheet, and old layouts alongside', async () => {
    const shared = ['Staff ID', 'Amount', 'Employee Name', 'Element', 'Period', 'Loan Type'];
    const result = await service.analyze(
      batch(DocumentType.REPAYMENT_SCHEDULE, '2026-10'),
      await workbookBuffer({
        NPF: [shared, ['PF1', 100, null, 'LOAN', '2026-10', null]],
        NSCDC: [shared, ['CD1', 200, 'Ada', null, null, null]],
        LASG: [['Report title'], [], ['Employee_Number', 'Employee_Name', 'Result_Value SUM'], ['L1', 'Ben', 300]],
      }),
    );
    expect(result.verdict).toBe('READY');
    expect(result.validRows).toBe(3);
  });

  it('requires a reupload when a repayment sheet has no staff or amount column', async () => {
    const result = await service.analyze(
      batch(DocumentType.REPAYMENT_SCHEDULE, '2026-10'),
      await workbookBuffer({ NPF: [['Name', 'Value'], ['Ada', 1]] }),
    );
    expect(result.verdict).toBe('REUPLOAD_REQUIRED');
  });

  it('requires a reupload for a loan book with no header row', async () => {
    const result = await service.analyze(batch(DocumentType.DISBURSED_LOANS), await workbookBuffer({ S: [['a', 'b']] }));
    expect(result.verdict).toBe('REUPLOAD_REQUIRED');
  });

  it.each([DocumentType.IPPIS_BROADSHEET, DocumentType.REPAYMENT_SCHEDULE, DocumentType.DISBURSED_LOANS])(
    'accepts its own %s template as mergeable',
    async (documentType) => {
      const result = await service.analyze(batch(documentType, '2026-10'), await buildTemplateWorkbook(documentType));
      expect(result.canMerge).toBe(true);
      expect(result.rowsToSkip).toBe(0);
    },
  );
});

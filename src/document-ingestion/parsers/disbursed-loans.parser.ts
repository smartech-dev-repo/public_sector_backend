import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType, Prisma } from '../../generated/prisma/client';
import { isLoanRowMappingFailure, mapLoanRow } from './loan-row-mapper';
import { buildRowByHeader } from './build-row-by-header';

const HEADER_SCAN_LIMIT = 20;

const SNAPSHOT_COLUMNS = [
  'id', 'customerId', 'customerName', 'accountNumber', 'address', 'branch', 'gender', 'phone',
  'ippisNumber', 'agency', 'loanAmount', 'principalBalance', 'disbursementDate', 'maturationDate',
  'effectiveDate', 'moratoriumDays', 'product', 'linkedAccountNumber', 'bvn', 'interestRatePercent',
  'accountOfficer', 'hasPreviouslyTakenLoan', 'rawFields', 'createdAt', 'updatedAt',
];

function findHeaderRowNumber(worksheet: ExcelJS.Worksheet): number | null {
  const maxScan = Math.min(worksheet.rowCount, HEADER_SCAN_LIMIT);
  for (let rowNumber = 1; rowNumber <= maxScan; rowNumber++) {
    const values = (worksheet.getRow(rowNumber).values as unknown[]) ?? [];
    const normalized = values.map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : null));
    if (normalized.includes('customer id') && normalized.includes('ippis')) {
      return rowNumber;
    }
  }
  return null;
}

@Injectable()
export class DisbursedLoansParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
  ) {}

  async parse(_batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled typings expect an older, non-generic Node `Buffer`
    // shape than this project's @types/node ships, hence `any` here.
    await workbook.xlsx.load(fileBuffer as any);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('Uploaded workbook has no worksheets');
    }

    const headerRowNumber = findHeaderRowNumber(worksheet);
    if (headerRowNumber === null) {
      throw new Error(
        `Could not locate a header row containing both "Customer ID" and "IPPIS" in the first ${HEADER_SCAN_LIMIT} rows`,
      );
    }

    const currentRecords = await this.prisma.loan.findMany();
    const existingCustomerIds = new Set(currentRecords.map((r) => r.customerId));

    const snapshot = await this.snapshotExportService.exportSnapshot({
      documentType: DocumentType.DISBURSED_LOANS,
      tableName: 'Loan',
      columns: SNAPSHOT_COLUMNS,
      rows: currentRecords.map((r) => ({
        ...r,
        rawFields: r.rawFields ? JSON.stringify(r.rawFields) : null,
      })),
    });

    let rowsProcessed = 0;
    let rowsCreated = 0;
    let rowsUpdated = 0;
    let rowsSkipped = 0;
    const warnings: string[] = [];

    const headerValues = worksheet.getRow(headerRowNumber).values as unknown[];

    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      rowsProcessed++;

      const rowByHeader = buildRowByHeader(headerValues, row.values as unknown[]);
      const mapped = mapLoanRow(rowByHeader);

      if (isLoanRowMappingFailure(mapped)) {
        rowsSkipped++;
        warnings.push(`Row ${rowNumber}: ${mapped.reason}`);
        continue;
      }
      warnings.push(...mapped.warnings.map((w) => `Row ${rowNumber}: ${w}`));

      const isUpdate = existingCustomerIds.has(mapped.record.customerId);

      await this.prisma.loan.upsert({
        where: { customerId: mapped.record.customerId },
        create: { ...mapped.record, rawFields: mapped.record.rawFields as Prisma.InputJsonValue },
        update: { ...mapped.record, rawFields: mapped.record.rawFields as Prisma.InputJsonValue },
      });

      if (isUpdate) {
        rowsUpdated++;
      } else {
        rowsCreated++;
      }
    }

    return { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId: snapshot.id };
  }
}

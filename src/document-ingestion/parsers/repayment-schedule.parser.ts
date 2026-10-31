import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType, Prisma } from '../../generated/prisma/client';
import { AgencyKey, isRepaymentHeaderRow, isRepaymentRowMappingFailure, mapRepaymentRow } from './repayment-row-mapper';
import { buildRowByHeader } from './build-row-by-header';
import { loadUploadedWorkbook } from './load-uploaded-workbook';

export const REPAYMENT_AGENCIES: AgencyKey[] = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOM', 'LASG'];
const HEADER_SCAN_LIMIT = 5;

const SNAPSHOT_COLUMNS = [
  'id', 'agency', 'staffId', 'period', 'elementName', 'elementDetail', 'amount', 'rawFields', 'createdAt',
];

// Row 1 in the template, but agency exports can carry a title block above it.
export function findRepaymentHeaderRowNumber(worksheet: ExcelJS.Worksheet): number | null {
  const maxScan = Math.min(worksheet.rowCount, HEADER_SCAN_LIMIT);
  for (let rowNumber = 1; rowNumber <= maxScan; rowNumber++) {
    const values = (worksheet.getRow(rowNumber).values as unknown[]) ?? [];
    const normalized = Array.from(values, (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null));
    if (isRepaymentHeaderRow(normalized)) {
      return rowNumber;
    }
  }
  return null;
}

@Injectable()
export class RepaymentScheduleParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
  ) {}

  async parse(batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = await loadUploadedWorkbook(batch, fileBuffer);

    const currentRecords = await this.prisma.loanRepaymentRecord.findMany();
    const existingKeys = new Set(
      currentRecords.map((r) => `${r.agency}::${r.staffId}::${r.period}::${r.elementName}`),
    );

    const snapshot = await this.snapshotExportService.exportSnapshot({
      documentType: DocumentType.REPAYMENT_SCHEDULE,
      tableName: 'LoanRepaymentRecord',
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

    for (const worksheet of workbook.worksheets) {
      const agency = REPAYMENT_AGENCIES.find((a) => a.toLowerCase() === worksheet.name.trim().toLowerCase());
      if (!agency) {
        warnings.push(`Unrecognized sheet "${worksheet.name}" skipped`);
        continue;
      }

      if (worksheet.rowCount === 0) continue;

      const headerRowNumber = findRepaymentHeaderRowNumber(worksheet);
      if (headerRowNumber === null) {
        warnings.push(`Could not locate a header row for sheet "${worksheet.name}"`);
        continue;
      }

      const headerValues = worksheet.getRow(headerRowNumber).values as unknown[];

      for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        rowsProcessed++;

        try {
          const rowByHeader = buildRowByHeader(headerValues, row.values as unknown[]);
          const mapped = mapRepaymentRow(rowByHeader);

          if (isRepaymentRowMappingFailure(mapped)) {
            rowsSkipped++;
            warnings.push(`Sheet "${agency}" row ${rowNumber}: ${mapped.reason}`);
            continue;
          }

          let period = mapped.record.period;
          if (period === null) {
            period = batch.period;
          } else if (batch.period && period !== batch.period) {
            warnings.push(
              `Sheet "${agency}" row ${rowNumber}: row period "${period}" does not match upload period "${batch.period}"`,
            );
          }

          const key = `${agency}::${mapped.record.staffId}::${period}::${mapped.record.elementName}`;
          const isUpdate = existingKeys.has(key);

          await this.prisma.loanRepaymentRecord.upsert({
            where: {
              agency_staffId_period_elementName: {
                agency,
                staffId: mapped.record.staffId,
                period,
                elementName: mapped.record.elementName,
              },
            },
            create: {
              agency,
              staffId: mapped.record.staffId,
              period,
              elementName: mapped.record.elementName,
              elementDetail: mapped.record.elementDetail,
              amount: mapped.record.amount,
              rawFields: mapped.record.rawFields as Prisma.InputJsonValue,
            },
            update: {
              elementDetail: mapped.record.elementDetail,
              amount: mapped.record.amount,
              rawFields: mapped.record.rawFields as Prisma.InputJsonValue,
            },
          });

          if (isUpdate) {
            rowsUpdated++;
          } else {
            rowsCreated++;
          }
        } catch (error) {
          rowsSkipped++;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`Sheet "${agency}" row ${rowNumber}: unexpected error - ${message}`);
        }
      }
    }

    return { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId: snapshot.id };
  }
}

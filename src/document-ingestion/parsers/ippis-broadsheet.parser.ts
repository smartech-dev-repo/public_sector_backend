import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { SectorService } from '../../sectors/sector.service';
import { normalizeSectorCode } from '../../sectors/sector-code.util';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType, Prisma } from '../../generated/prisma/client';
import { IPPIS_KNOWN_HEADERS, isRowMappingFailure, mapIppisRow } from './ippis-row-mapper';
import { buildRowByHeader } from './build-row-by-header';
import { loadUploadedWorkbook } from './load-uploaded-workbook';

export const REQUIRED_IPPIS_HEADERS = ['staff id', 'employee name'];

/** Whether a sheet with an unknown name holds staff records, so the review can say what would be left out. */
export function isIppisDataSheet(worksheet: ExcelJS.Worksheet): boolean {
  if (worksheet.rowCount <= 1) return false;
  const headers = new Set(
    (worksheet.getRow(1).values as unknown[])
      .filter((header): header is string => typeof header === 'string')
      .map((header) => header.trim().toLowerCase()),
  );
  return REQUIRED_IPPIS_HEADERS.every((header) => headers.has(header));
}

const SNAPSHOT_COLUMNS = [
  'id', 'agency', 'staffId', 'employeeName', 'employeeStatus', 'hireDate', 'dateOfBirth',
  'maritalStatus', 'gender', 'jobTitle', 'department', 'subOrganization', 'grade', 'step',
  'salary', 'paymentThreeMonthsAgo', 'paymentTwoMonthsAgo', 'paymentLastMonth', 'phone', 'bankName', 'accountNumber', 'pfaName', 'pinNumber', 'dateTerminated',
  'bvn', 'legacyId', 'rawFields', 'createdAt', 'updatedAt',
];

@Injectable()
export class IppisBroadsheetParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
    private readonly sectorService: SectorService,
  ) {}

  async parse(batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = await loadUploadedWorkbook(batch, fileBuffer);
    const sectors = await this.sectorService.codes();

    const currentRecords = await this.prisma.ippisRecord.findMany();
    const existingKeys = new Set(currentRecords.map((r) => `${r.agency}::${r.staffId}`));

    const snapshot = await this.snapshotExportService.exportSnapshot({
      documentType: DocumentType.IPPIS_BROADSHEET,
      tableName: 'IppisRecord',
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
      const agency = normalizeSectorCode(worksheet.name);
      if (!sectors.includes(agency)) {
        warnings.push(`Sheet "${worksheet.name}" skipped: it is not a set-up sector`);
        continue;
      }

      const headerValues = worksheet.getRow(1).values as unknown[];

      const normalizedHeaders = new Set(
        headerValues
          .filter((h): h is string => typeof h === 'string')
          .map((h) => h.trim().toLowerCase()),
      );
      for (const [headerKey, fieldName] of Object.entries(IPPIS_KNOWN_HEADERS)) {
        if (!normalizedHeaders.has(headerKey)) {
          warnings.push(
            `Sheet "${agency}": expected column "${headerKey}" not found in the header row — every row's "${fieldName}" will be null`,
          );
        }
      }

      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
        const row = worksheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        rowsProcessed++;

        const rowByHeader = buildRowByHeader(headerValues, row.values as unknown[]);
        const mapped = mapIppisRow(rowByHeader);

        if (isRowMappingFailure(mapped)) {
          rowsSkipped++;
          warnings.push(`Sheet "${agency}" row ${rowNumber}: ${mapped.reason}`);
          continue;
        }
        warnings.push(...mapped.warnings.map((w) => `Sheet "${agency}" row ${rowNumber}: ${w}`));

        const key = `${agency}::${mapped.record.staffId}`;
        const isUpdate = existingKeys.has(key);

        await this.prisma.ippisRecord.upsert({
          where: { agency_staffId: { agency, staffId: mapped.record.staffId } },
          create: { agency, ...mapped.record, rawFields: mapped.record.rawFields as Prisma.InputJsonValue },
          update: { ...mapped.record, rawFields: mapped.record.rawFields as Prisma.InputJsonValue },
        });

        if (isUpdate) {
          rowsUpdated++;
        } else {
          rowsCreated++;
        }
      }
    }

    return { rowsProcessed, rowsCreated, rowsUpdated, rowsSkipped, warnings, snapshotExportId: snapshot.id };
  }
}

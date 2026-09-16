import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { SnapshotExportService } from '../snapshot-export.service';
import { DocumentParser, ParseResult } from '../document-parser.interface';
import { DocumentUploadBatch, DocumentType, Prisma } from '../../generated/prisma/client';
import { isRowMappingFailure, mapIppisRow } from './ippis-row-mapper';

const KNOWN_AGENCIES = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL'];

const SNAPSHOT_COLUMNS = [
  'id', 'agency', 'staffId', 'employeeName', 'employeeStatus', 'hireDate', 'dateOfBirth',
  'maritalStatus', 'gender', 'jobTitle', 'department', 'subOrganization', 'grade', 'step',
  'salary', 'phone', 'bankName', 'accountNumber', 'pfaName', 'pinNumber', 'dateTerminated',
  'bvn', 'legacyId', 'rawFields', 'createdAt', 'updatedAt',
];

function buildRowByHeader(headerValues: unknown[], rowValues: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  headerValues.forEach((header, index) => {
    if (typeof header !== 'string' || !header.trim()) return;
    result[header.trim().toLowerCase()] = rowValues[index];
  });
  return result;
}

@Injectable()
export class IppisBroadsheetParser implements DocumentParser {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshotExportService: SnapshotExportService,
  ) {}

  async parse(_batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled typings expect an older, non-generic Node `Buffer`
    // shape than this project's @types/node ships, hence `any` here.
    await workbook.xlsx.load(fileBuffer as any);

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
      const agency = KNOWN_AGENCIES.find((a) => a.toLowerCase() === worksheet.name.trim().toLowerCase());
      if (!agency) {
        warnings.push(`Unrecognized sheet "${worksheet.name}" skipped`);
        continue;
      }

      const headerValues = worksheet.getRow(1).values as unknown[];

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

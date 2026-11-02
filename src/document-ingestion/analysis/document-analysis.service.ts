import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType, DocumentUploadBatch } from '../../generated/prisma/client';
import { normalizeNigerianPhone } from '../../common/normalize-nigerian-phone.util';
import { buildRowByHeader } from '../parsers/build-row-by-header';
import { loadUploadedWorkbook } from '../parsers/load-uploaded-workbook';
import { IPPIS_AGENCIES } from '../parsers/ippis-broadsheet.parser';
import { IPPIS_KNOWN_HEADERS, isRowMappingFailure, mapIppisRow } from '../parsers/ippis-row-mapper';
import { HEADER_SCAN_LIMIT, findHeaderRowNumber } from '../parsers/disbursed-loans.parser';
import { isLoanRowMappingFailure, mapLoanRow } from '../parsers/loan-row-mapper';
import { REPAYMENT_AGENCIES, findRepaymentHeaderRowNumber } from '../parsers/repayment-schedule.parser';
import { isRepaymentRowMappingFailure, mapRepaymentRow } from '../parsers/repayment-row-mapper';
import { AnalysisBuilder, DocumentAnalysis } from './analysis-builder';

const REQUIRED_IPPIS_HEADERS = ['staff id', 'employee name'];
const VALID_E164_NIGERIAN_PHONE = /^\+234\d{10}$/;

function headerSet(headerValues: unknown[]): Set<string> {
  return new Set(
    headerValues.filter((h): h is string => typeof h === 'string').map((h) => h.trim().toLowerCase()),
  );
}

// Dry run of the three parsers: the same mappers decide what a row means, but
// nothing is written, so the review step can report what a merge would do.
// This runs in the API process, so a long unbroken loop would stall every request
// and stop the queue renewing its lock on the job.
const YIELD_EVERY_ROWS = 500;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

@Injectable()
export class DocumentAnalysisService {
  constructor(private readonly prisma: PrismaService) {}

  async analyze(batch: DocumentUploadBatch, fileBuffer: Buffer): Promise<DocumentAnalysis> {
    const builder = new AnalysisBuilder();
    let workbook: ExcelJS.Workbook;
    try {
      workbook = await loadUploadedWorkbook(batch, fileBuffer);
    } catch {
      builder.addIssue('CRITICAL', 'This file could not be read. Save it again as .xlsx or .csv and upload it again');
      return builder.build();
    }

    switch (batch.documentType) {
      case DocumentType.IPPIS_BROADSHEET:
        await this.analyzeIppis(workbook, builder);
        break;
      case DocumentType.REPAYMENT_SCHEDULE:
        await this.analyzeRepayments(workbook, batch.period, builder);
        break;
      case DocumentType.DISBURSED_LOANS:
        await this.analyzeLoans(workbook, builder);
        break;
    }
    return builder.build();
  }

  private async analyzeIppis(workbook: ExcelJS.Workbook, builder: AnalysisBuilder): Promise<void> {
    const existing = await this.prisma.ippisRecord.findMany({ select: { agency: true, staffId: true } });
    const existingKeys = new Set(existing.map((r) => `${r.agency}::${r.staffId}`));
    const seenStaff = new Set<string>();
    const staffByPhone = new Map<string, string>();
    let recognizedSheets = 0;

    for (const worksheet of workbook.worksheets) {
      const agency = IPPIS_AGENCIES.find((a) => a.toLowerCase() === worksheet.name.trim().toLowerCase());
      const sheet = builder.addSheet(worksheet.name, Boolean(agency));
      if (!agency) {
        builder.addIssue('WARNING', `Unrecognized sheet "${worksheet.name}" will be ignored`);
        continue;
      }
      recognizedSheets++;

      const headerValues = worksheet.getRow(1).values as unknown[];
      const headers = headerSet(headerValues);
      const missingRequired = REQUIRED_IPPIS_HEADERS.filter((header) => !headers.has(header));
      if (missingRequired.length > 0 && worksheet.rowCount > 1) {
        for (const header of missingRequired) {
          builder.addIssue('CRITICAL', `Required column "${header}" is missing`, { sheet: agency });
        }
      }
      if (worksheet.rowCount <= 1) continue;
      for (const header of Object.keys(IPPIS_KNOWN_HEADERS)) {
        if (!headers.has(header) && !REQUIRED_IPPIS_HEADERS.includes(header)) {
          builder.addIssue('WARNING', `Column "${header}" is missing, so it will be blank for every row`, { sheet: agency });
        }
      }

      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
       if (rowNumber % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
        if (rowNumber % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
        const row = worksheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        builder.countRow(sheet);
        const location = { sheet: agency, row: rowNumber };

        const mapped = mapIppisRow(buildRowByHeader(headerValues, row.values as unknown[]));
        if (isRowMappingFailure(mapped)) {
          builder.addIssue('ERROR', mapped.reason, location);
          continue;
        }
        mapped.warnings.forEach((warning) => builder.addIssue('WARNING', warning, location));

        const { staffId, phone } = mapped.record;
        const key = `${agency}::${staffId}`;
        if (seenStaff.has(key)) {
          builder.addIssue('WARNING', 'Duplicate Staff ID in this file; the last row wins', location);
        }
        seenStaff.add(key);

        if (!phone) {
          if (headers.has('telephone number')) {
            builder.addIssue('WARNING', 'No telephone number, so this staff member cannot onboard', location);
          }
        } else {
          const normalizedPhone = normalizeNigerianPhone(phone);
          if (!VALID_E164_NIGERIAN_PHONE.test(normalizedPhone)) {
            builder.addIssue('WARNING', 'Telephone number is not a valid Nigerian number, so this staff member cannot onboard', location);
          } else if (staffByPhone.has(normalizedPhone) && staffByPhone.get(normalizedPhone) !== key) {
            builder.addIssue('WARNING', 'Telephone number is shared with another staff member, so only one of them can onboard', location);
          } else {
            staffByPhone.set(normalizedPhone, key);
          }
        }

        builder.countValidRow(sheet, existingKeys.has(key));
      }
    }

    if (recognizedSheets === 0) {
      builder.addIssue('CRITICAL', `No agency sheet found. Sheets must be named ${IPPIS_AGENCIES.join(', ')}`);
    }
  }

  private async analyzeRepayments(
    workbook: ExcelJS.Workbook,
    period: string | null,
    builder: AnalysisBuilder,
  ): Promise<void> {
    const [existing, staff] = await Promise.all([
      this.prisma.loanRepaymentRecord.findMany({
        select: { agency: true, staffId: true, period: true, elementName: true },
      }),
      this.prisma.ippisRecord.findMany({ select: { agency: true, staffId: true } }),
    ]);
    const existingKeys = new Set(existing.map((r) => `${r.agency}::${r.staffId}::${r.period}::${r.elementName}`));
    const knownStaff = new Set(staff.map((r) => `${r.agency}::${r.staffId}`));
    const agenciesOnPayroll = new Set(staff.map((r) => r.agency));
    const seenKeys = new Set<string>();
    let recognizedSheets = 0;

    for (const worksheet of workbook.worksheets) {
      const agency = REPAYMENT_AGENCIES.find((a) => a.toLowerCase() === worksheet.name.trim().toLowerCase());
      const sheet = builder.addSheet(worksheet.name, Boolean(agency));
      if (!agency) {
        builder.addIssue('WARNING', `Unrecognized sheet "${worksheet.name}" will be ignored`);
        continue;
      }
      recognizedSheets++;

      if (worksheet.rowCount === 0) continue;

      const headerRowNumber = findRepaymentHeaderRowNumber(worksheet);
      if (headerRowNumber === null) {
        builder.addIssue('CRITICAL', 'Could not find the header row. "Staff ID" and "Amount" columns are required', { sheet: agency });
        continue;
      }

      const headerValues = worksheet.getRow(headerRowNumber).values as unknown[];

      for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
        if (rowNumber % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
        const row = worksheet.getRow(rowNumber);
        if (!row.hasValues) continue;
        builder.countRow(sheet);
        const location = { sheet: agency, row: rowNumber };

        const mapped = mapRepaymentRow(buildRowByHeader(headerValues, row.values as unknown[]));
        if (isRepaymentRowMappingFailure(mapped)) {
          builder.addIssue('ERROR', mapped.reason, location);
          continue;
        }
        mapped.warnings.forEach((warning) => builder.addIssue('WARNING', warning, location));

        const rowPeriod = mapped.record.period ?? period;
        if (mapped.record.period && period && mapped.record.period !== period) {
          builder.addIssue('WARNING', `Row period "${mapped.record.period}" does not match the upload month`, location);
        }
        if (agenciesOnPayroll.has(agency) && !knownStaff.has(`${agency}::${mapped.record.staffId}`)) {
          builder.addIssue('WARNING', 'Staff number is not on the IPPIS record', location);
        }

        const key = `${agency}::${mapped.record.staffId}::${rowPeriod}::${mapped.record.elementName}`;
        if (seenKeys.has(key)) {
          builder.addIssue('WARNING', 'Duplicate deduction in this file; the last row wins', location);
        }
        seenKeys.add(key);

        builder.countValidRow(sheet, existingKeys.has(key));
      }
    }

    if (recognizedSheets === 0) {
      builder.addIssue('CRITICAL', `No agency sheet found. Sheets must be named ${REPAYMENT_AGENCIES.join(', ')}`);
    }
  }

  private async analyzeLoans(workbook: ExcelJS.Workbook, builder: AnalysisBuilder): Promise<void> {
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      builder.addIssue('CRITICAL', 'This workbook has no worksheets');
      return;
    }

    const headerRowNumber = findHeaderRowNumber(worksheet);
    if (headerRowNumber === null) {
      builder.addIssue(
        'CRITICAL',
        `Could not find a header row containing both "Customer ID" and "IPPIS" in the first ${HEADER_SCAN_LIMIT} rows`,
      );
      return;
    }

    const [existing, staff] = await Promise.all([
      this.prisma.loan.findMany({ select: { customerId: true } }),
      this.prisma.ippisRecord.findMany({ select: { staffId: true } }),
    ]);
    const existingCustomerIds = new Set(existing.map((r) => r.customerId));
    const knownStaff = new Set(staff.map((r) => r.staffId.toLowerCase()));
    const seenCustomers = new Set<string>();

    const sheet = builder.addSheet(worksheet.name, true);
    const headerValues = worksheet.getRow(headerRowNumber).values as unknown[];

    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
      if (rowNumber % YIELD_EVERY_ROWS === 0) await yieldToEventLoop();
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      builder.countRow(sheet);
      const location = { sheet: worksheet.name, row: rowNumber };

      const mapped = mapLoanRow(buildRowByHeader(headerValues, row.values as unknown[]));
      if (isLoanRowMappingFailure(mapped)) {
        builder.addIssue('ERROR', mapped.reason, location);
        continue;
      }
      mapped.warnings.forEach((warning) => builder.addIssue('WARNING', warning, location));

      if (staff.length > 0 && !knownStaff.has(mapped.record.ippisNumber.toLowerCase())) {
        builder.addIssue('WARNING', 'IPPIS number is not on the IPPIS record', location);
      }
      if (seenCustomers.has(mapped.record.customerId)) {
        builder.addIssue('WARNING', 'Duplicate Customer ID in this file; the last row wins', location);
      }
      seenCustomers.add(mapped.record.customerId);

      builder.countValidRow(sheet, existingCustomerIds.has(mapped.record.customerId));
    }
  }
}

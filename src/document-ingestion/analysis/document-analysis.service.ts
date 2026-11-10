import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../../prisma/prisma.service';
import { DocumentType, DocumentUploadBatch } from '../../generated/prisma/client';
import { validNigerianPhone } from '../../common/normalize-nigerian-phone.util';
import { buildRowByHeader } from '../parsers/build-row-by-header';
import { loadUploadedWorkbook } from '../parsers/load-uploaded-workbook';
import { REQUIRED_IPPIS_HEADERS, isIppisDataSheet } from '../parsers/ippis-broadsheet.parser';
import { SectorService } from '../../sectors/sector.service';
import { closestSector, normalizeSectorCode } from '../../sectors/sector-code.util';
import { IPPIS_KNOWN_HEADERS, isRowMappingFailure, mapIppisRow } from '../parsers/ippis-row-mapper';
import { HEADER_SCAN_LIMIT, findHeaderRowNumber } from '../parsers/disbursed-loans.parser';
import { isLoanRowMappingFailure, mapLoanRow } from '../parsers/loan-row-mapper';
import { findRepaymentHeaderRowNumber, isRepaymentDataSheet } from '../parsers/repayment-schedule.parser';
import { isRepaymentRowMappingFailure, mapRepaymentRow } from '../parsers/repayment-row-mapper';
import { AnalysisBuilder, DocumentAnalysis } from './analysis-builder';
import { PHONE_ALREADY_USED, buildIppisPhoneRegister, ippisKey } from '../ippis-phone-register';
import { RepaymentMatchingService } from '../../reconciliation/repayment-matching.service';
import { MATCH_STATUS_MESSAGES, staffKey } from '../../reconciliation/deduction-match.util';


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
  constructor(
    private readonly prisma: PrismaService,
    private readonly sectorService: SectorService,
    private readonly repaymentMatchingService: RepaymentMatchingService,
  ) {}

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
        await this.analyzeIppis(workbook, await this.sectorService.codes(), builder);
        break;
      case DocumentType.REPAYMENT_SCHEDULE:
        await this.analyzeRepayments(workbook, await this.sectorService.codes(), batch.period, builder);
        break;
      case DocumentType.DISBURSED_LOANS:
        await this.analyzeLoans(workbook, builder);
        break;
    }
    return builder.build();
  }

  private async analyzeIppis(workbook: ExcelJS.Workbook, sectors: string[], builder: AnalysisBuilder): Promise<void> {
    const existing = await this.prisma.ippisRecord.findMany({ select: { agency: true, staffId: true, phone: true } });
    const existingKeys = new Set(existing.map((r) => ippisKey(r.agency, r.staffId)));
    const phones = await buildIppisPhoneRegister(this.prisma, existing, workbook, sectors);
    const seenStaff = new Set<string>();
    let recognizedSheets = 0;

    for (const worksheet of workbook.worksheets) {
      const agency = normalizeSectorCode(worksheet.name);
      const isKnownSector = sectors.includes(agency);
      const sheet = builder.addSheet(worksheet.name, isKnownSector);
      if (!isKnownSector) {
        if (isIppisDataSheet(worksheet)) {
          builder.addUnknownSector(worksheet.name.trim(), Math.max(worksheet.actualRowCount - 1, 0), closestSector(agency, sectors));
        } else {
          builder.addIssue('WARNING', 'Sheet has no data columns and will be ignored', { sheet: worksheet.name });
        }
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
        const key = ippisKey(agency, staffId);
        if (seenStaff.has(key)) {
          builder.addIssue('WARNING', 'Duplicate Staff ID in this file; the last row wins', location);
        }
        seenStaff.add(key);

        if (!phone) {
          if (headers.has('telephone number')) {
            builder.addIssue('WARNING', 'No telephone number, so this staff member cannot onboard', location);
          }
        } else {
          if (!validNigerianPhone(phone)) {
            builder.addIssue('WARNING', 'Telephone number is not a valid Nigerian number, so this staff member cannot onboard', location);
          } else if (!phones.claim(key, phone)) {
            builder.addIssue('ERROR', PHONE_ALREADY_USED, location);
            continue;
          }
        }

        builder.countValidRow(sheet, existingKeys.has(key));
      }
    }

    if (recognizedSheets === 0) {
      builder.addIssue('CRITICAL', 'No set-up sector found. Name each sheet after a sector in Configuration, or add the sector there first');
    }
  }

  private async analyzeRepayments(
    workbook: ExcelJS.Workbook,
    sectors: string[],
    period: string | null,
    builder: AnalysisBuilder,
  ): Promise<void> {
    const [existing, staff, loans] = await Promise.all([
      this.prisma.loanRepaymentRecord.findMany({
        select: { agency: true, staffId: true, period: true, elementName: true, amount: true },
      }),
      this.prisma.ippisRecord.findMany({ select: { agency: true, staffId: true } }),
      this.repaymentMatchingService.buildContext(),
    ]);
    // Each month already uploaded, as its set of deductions, to spot the same file sent for another month.
    const uploadedMonths = new Map<string, Set<string>>();
    for (const r of existing) {
      if (!r.period) continue;
      const set = uploadedMonths.get(r.period) ?? new Set<string>();
      set.add(deductionFingerprint(r.agency, r.staffId, r.elementName, Number(r.amount)));
      uploadedMonths.set(r.period, set);
    }
    const fileMonths = new Map<string, Set<string>>();
    const existingKeys = new Set(existing.map((r) => `${r.agency}::${r.staffId}::${r.period}::${r.elementName}`));
    const knownStaff = new Set(staff.map((r) => `${r.agency}::${r.staffId}`));
    const agenciesOnPayroll = new Set(staff.map((r) => r.agency));
    const seenKeys = new Set<string>();
    let recognizedSheets = 0;

    for (const worksheet of workbook.worksheets) {
      const agency = normalizeSectorCode(worksheet.name);
      const isKnownSector = sectors.includes(agency);
      const sheet = builder.addSheet(worksheet.name, isKnownSector);
      if (!isKnownSector) {
        if (isRepaymentDataSheet(worksheet)) {
          builder.addUnknownSector(worksheet.name.trim(), worksheet.rowCount - (findRepaymentHeaderRowNumber(worksheet) ?? 0), closestSector(agency, sectors));
        } else {
          builder.addIssue('WARNING', 'Sheet has no data columns and will be ignored', { sheet: worksheet.name });
        }
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

        if (rowPeriod) {
          const match = loans.match({ agency, staffId: mapped.record.staffId, period: rowPeriod });
          if (match.status !== 'MATCHED') {
            builder.addIssue('WARNING', `${MATCH_STATUS_MESSAGES[match.status]}. It will be kept as unmatched for reconciliation`, location);
          }
          const set = fileMonths.get(rowPeriod) ?? new Set<string>();
          set.add(deductionFingerprint(agency, mapped.record.staffId, mapped.record.elementName, mapped.record.amount));
          fileMonths.set(rowPeriod, set);
        } else {
          builder.addIssue('WARNING', 'Deduction has no month. Choose the month at upload or fill the Period column', location);
        }

        const key = `${agency}::${mapped.record.staffId}::${rowPeriod}::${mapped.record.elementName}`;
        if (seenKeys.has(key)) {
          builder.addIssue('WARNING', 'Duplicate deduction in this file; the last row wins', location);
        }
        seenKeys.add(key);

        builder.countValidRow(sheet, existingKeys.has(key));
      }
    }

    for (const [month, deductions] of fileMonths) {
      if (deductions.size < 2) continue;
      for (const [uploaded, previous] of uploadedMonths) {
        if (uploaded === month || previous.size !== deductions.size) continue;
        if ([...deductions].every((d) => previous.has(d))) {
          builder.addIssue(
            'WARNING',
            `Every deduction for ${month} is the same as the upload for ${uploaded}. Check that this is the right file and month`,
          );
        }
      }
    }

    if (recognizedSheets === 0) {
      builder.addIssue('CRITICAL', 'No set-up sector found. Name each sheet after a sector in Configuration, or add the sector there first');
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

function deductionFingerprint(agency: string, staffId: string, elementName: string, amount: number): string {
  return `${staffKey(agency, staffId)}::${elementName}::${amount.toFixed(2)}`;
}

import { Readable } from 'stream';
import * as ExcelJS from 'exceljs';
import { DocumentUploadBatch } from '../../generated/prisma/client';

const UTF8_BOM = /^﻿/;

export function isCsvFile(fileName: string | undefined): boolean {
  return Boolean(fileName?.toLowerCase().endsWith('.csv'));
}

// A CSV becomes a one-sheet workbook named after the agency chosen at upload, so
// the parsers route it exactly like an .xlsx sheet. Cells stay as text: exceljs's
// default mapping would turn account numbers and BVNs into numbers and drop their
// leading zeros, and the row mappers already parse amounts and dates from strings.
export async function loadUploadedWorkbook(
  batch: Pick<DocumentUploadBatch, 'originalFileName' | 'sheetName'>,
  fileBuffer: Buffer,
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (isCsvFile(batch.originalFileName)) {
    await workbook.csv.read(Readable.from(fileBuffer.toString('utf8').replace(UTF8_BOM, '')), {
      sheetName: batch.sheetName ?? undefined,
      map: (value: string) => (value === '' ? null : value),
    });
    return workbook;
  }
  // exceljs's bundled typings expect an older, non-generic Node `Buffer`
  // shape than this project's @types/node ships, hence `any` here.
  await workbook.xlsx.load(fileBuffer as any);
  return workbook;
}

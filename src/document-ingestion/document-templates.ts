import * as ExcelJS from 'exceljs';
import { DocumentType } from '../generated/prisma/client';
import { MAX_SPREADSHEET_BYTES } from './spreadsheet-upload.options';
import { KNOWN_AGENCIES } from '../common/known-agencies.constant';

export interface TemplateColumn {
  header: string;
  required: boolean;
  format: string;
  description: string;
  example: string | number;
}

export interface TemplateSheet {
  names: string[];
  columns: TemplateColumn[];
}

export interface DocumentTemplate {
  documentType: DocumentType;
  title: string;
  fileName: string;
  summary: string;
  acceptedFormats: string[];
  // Agencies a CSV can be uploaded for; empty when a CSV needs no agency.
  csvAgencies: string[];
  maxFileSizeBytes: number;
  requiresPeriod: boolean;
  notes: string[];
  sheets: TemplateSheet[];
}

export const DOCUMENT_SLUGS: Record<string, DocumentType> = {
  'ippis-broadsheet': DocumentType.IPPIS_BROADSHEET,
  'repayment-schedule': DocumentType.REPAYMENT_SCHEDULE,
  'disbursed-loans': DocumentType.DISBURSED_LOANS,
};

export const DOCUMENT_UPLOAD_PERMISSIONS: Record<DocumentType, string> = {
  [DocumentType.IPPIS_BROADSHEET]: 'ippis:upload',
  [DocumentType.REPAYMENT_SCHEDULE]: 'repayments:upload',
  [DocumentType.DISBURSED_LOANS]: 'loans:upload',
};

const optional = (header: string, format: string, description: string, example: string | number): TemplateColumn => ({
  header, required: false, format, description, example,
});
const required = (header: string, format: string, description: string, example: string | number): TemplateColumn => ({
  header, required: true, format, description, example,
});

const IPPIS_COLUMNS: TemplateColumn[] = [
  required('Staff ID', 'Text', 'IPPIS number. Unique within an agency; an existing Staff ID is updated, a new one is added.', 'PF0000001'),
  required('Employee Name', 'Text', 'Full name as on payroll.', 'SAMPLE EMPLOYEE'),
  optional('Employee Status', 'Text', 'Employment status on payroll.', 'ACTIVE'),
  optional('Hire Date', 'Date (YYYY-MM-DD)', 'First appointment date. Used to work out length of service.', '2015-03-02'),
  optional('Date of Birth', 'Date (YYYY-MM-DD)', 'Used for the retirement-age check.', '1985-07-19'),
  optional('Marital Status', 'Text', 'Marital status.', 'MARRIED'),
  optional('Gender', 'Text', 'Gender.', 'MALE'),
  optional('Job Title', 'Text', 'Job title.', 'INSPECTOR'),
  optional('Department', 'Text', 'Department.', 'OPERATIONS'),
  optional('Sub Organization', 'Text', 'Sub-organization or command.', 'LAGOS COMMAND'),
  optional('Grade', 'Text', 'Grade level.', 'GL08'),
  optional('Step', 'Text', 'Step.', '4'),
  optional('Salary', 'Number, no commas or ₦', 'Monthly salary.', 150000),
  optional('Payment 3 Months Ago', 'Number, no commas or ₦', 'Amount paid three months before this broadsheet. Feeds loan and top-up eligibility.', 150000),
  optional('Payment 2 Months Ago', 'Number, no commas or ₦', 'Amount paid two months before this broadsheet.', 150000),
  optional('Payment Last Month', 'Number, no commas or ₦', 'Amount paid in the month before this broadsheet.', 150000),
  optional('Telephone Number', '10 or 11 digits, or +234…', 'Required in practice: a client can only onboard with the phone number held here.', '8000000000'),
  optional('Bank Name', 'Text', 'Salary bank.', 'SAMPLE BANK'),
  optional('Account Number', '10 digits, as text', 'Salary account number.', '0000000000'),
  optional('PFA Name', 'Text', 'Pension fund administrator.', 'SAMPLE PFA'),
  optional('PIN Number', 'Text', 'Pension PIN.', 'PEN000000000000'),
  optional('Date Terminated', 'Date (YYYY-MM-DD)', 'Leave blank for serving staff.', ''),
  optional('BVN', '11 digits, as text', 'A row with a BVN that is not 11 digits is rejected.', '00000000000'),
  optional('Legacy ID', 'Text', 'Previous staff identifier, if any.', ''),
];

const REPAYMENT_COLUMNS: TemplateColumn[] = [
  required('Staff ID', 'Text', 'IPPIS or staff number, as on the IPPIS record.', 'PF0000001'),
  required('Amount', 'Number, no commas or ₦', 'Amount deducted for the month.', 25000),
  optional('Employee Name', 'Text', 'Helps you check the row. Kept for reference only.', 'SAMPLE EMPLOYEE'),
  optional('Element', 'Text', 'Deduction element. Use this when one staff member has several deductions in a month. Blank means LOAN_REPAYMENT.', 'LOAN REPAYMENT'),
  optional('Period', 'YYYY-MM or "October 2026"', 'Deduction month. Blank uses the month chosen at upload.', '2026-10'),
  optional('Loan Type', 'Text', 'Loan type, where the agency reports it.', 'SALARY LOAN'),
];

const LOAN_COLUMNS: TemplateColumn[] = [
  required('Customer ID', 'Text', 'Unique loan customer ID. An existing ID is updated.', 'CUST000001'),
  required('Customer Name', 'Text', 'Customer name.', 'SAMPLE EMPLOYEE'),
  required('Account No.', 'Text', 'Loan account number.', '0000000000'),
  optional('Address', 'Text', 'Address.', ''),
  optional('Branch', 'Text', 'Branch.', 'HEAD OFFICE'),
  optional('Gender', 'Text', 'Gender.', 'MALE'),
  optional('Phone No.', 'Text', 'Phone number.', '8000000000'),
  required('IPPIS', 'Text, with agency prefix', 'IPPIS number. The prefix (PF, CD, NI, PR, NCS) sets the agency.', 'PF0000001'),
  required('Loan Amount', 'Number', 'Amount disbursed.', 500000),
  required('Principal Bal.', 'Number', 'Outstanding principal.', 450000),
  required('Disbursement Date', 'Date', 'Disbursement date.', '02-Jan-2026'),
  required('Maturation Date', 'Date', 'Final repayment date.', '02-Jan-2027'),
  optional('Effective Date', 'Date', 'Effective date.', ''),
  optional('Moratarium (Day)', 'Whole number', 'Moratorium in days.', 0),
  required('Product', 'Text', 'Loan product name.', 'SALARY LOAN'),
  optional('Linked Account Number', 'Text', 'Linked account.', ''),
  optional('BVN', '11 digits, as text', 'BVN.', ''),
  required('Interest Rate', 'Number', 'Interest rate percent.', 3.5),
  optional('Account Officer', 'Text', 'Account officer.', ''),
  optional('Has Previously Taken Loan', 'Yes / No', 'Whether the customer has borrowed before.', 'No'),
];

export const DOCUMENT_TEMPLATES: Record<DocumentType, DocumentTemplate> = {
  [DocumentType.IPPIS_BROADSHEET]: {
    documentType: DocumentType.IPPIS_BROADSHEET,
    title: 'IPPIS Broadsheet',
    fileName: 'ippis-broadsheet-template.xlsx',
    summary: 'The monthly payroll master. Each row adds or updates one staff record.',
    acceptedFormats: ['.xlsx', '.csv'],
    csvAgencies: [...KNOWN_AGENCIES],
    maxFileSizeBytes: MAX_SPREADSHEET_BYTES,
    requiresPeriod: false,
    notes: [
      'In .xlsx, keep one sheet per sector, named after the sector. A new sector must be added in Configuration first. Other sheets are not merged.',
      'A .csv holds one sector: use the same columns and choose the sector in the next step.',
      'Keep the headers in row 1 and do not rename them.',
      'Fill the three payment columns oldest to newest: 3 months ago, 2 months ago, last month.',
      'Blank cells overwrite what is on record for that staff member.',
    ],
    sheets: [{ names: [...KNOWN_AGENCIES], columns: IPPIS_COLUMNS }],
  },
  [DocumentType.REPAYMENT_SCHEDULE]: {
    documentType: DocumentType.REPAYMENT_SCHEDULE,
    title: 'Repayment Schedule',
    fileName: 'repayment-schedule-template.xlsx',
    summary: 'Monthly deductions per agency, used for repayment reconciliation.',
    acceptedFormats: ['.xlsx', '.csv'],
    csvAgencies: [...KNOWN_AGENCIES],
    maxFileSizeBytes: MAX_SPREADSHEET_BYTES,
    requiresPeriod: true,
    notes: [
      'Every agency sheet uses the same columns. Leave optional columns blank where an agency does not report them.',
      'In .xlsx, name each sheet after its sector. A new sector must be added in Configuration first. Sheets you do not need can stay empty.',
      'A .csv holds one sector: use the same columns and choose the sector in the next step.',
      'Choose the repayment month in the next step. Sheets with no Period column use that month.',
      'Merging a schedule re-runs repayment reconciliation.',
    ],
    sheets: [{ names: [...KNOWN_AGENCIES], columns: REPAYMENT_COLUMNS }],
  },
  [DocumentType.DISBURSED_LOANS]: {
    documentType: DocumentType.DISBURSED_LOANS,
    title: 'Disbursed Loans',
    fileName: 'disbursed-loans-template.xlsx',
    summary: 'The disbursed loan book. Each row adds or updates one loan by Customer ID.',
    acceptedFormats: ['.xlsx', '.csv'],
    csvAgencies: [],
    maxFileSizeBytes: MAX_SPREADSHEET_BYTES,
    requiresPeriod: false,
    notes: [
      'In .xlsx, only the first sheet is read.',
      'The header row must contain "Customer ID" and "IPPIS" within the first 20 rows.',
      'Merging a loan book re-runs repayment reconciliation.',
    ],
    sheets: [{ names: ['Disbursed Loans'], columns: LOAN_COLUMNS }],
  },
};

/** A template with the live sector list. A type without per-sector sheets is unchanged. */
export function templateForSectors(documentType: DocumentType, sectors: string[]): DocumentTemplate {
  const template = DOCUMENT_TEMPLATES[documentType];
  if (template.csvAgencies.length === 0) return template;
  return { ...template, csvAgencies: sectors, sheets: template.sheets.map((sheet) => ({ ...sheet, names: sectors })) };
}

export async function buildTemplateWorkbook(documentType: DocumentType, sectors: string[] = [...KNOWN_AGENCIES]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of templateForSectors(documentType, sectors).sheets) {
    sheet.names.forEach((name, index) => {
      const worksheet = workbook.addWorksheet(name);
      const header = worksheet.addRow(sheet.columns.map((column) => column.header));
      header.font = { bold: true };
      // Identifier columns must stay text: a numeric cell drops leading zeros.
      worksheet.columns.forEach((column) => {
        column.numFmt = '@';
        column.width = 20;
      });
      if (index === 0) {
        worksheet.addRow(sheet.columns.map((column) => column.example));
      }
    });
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

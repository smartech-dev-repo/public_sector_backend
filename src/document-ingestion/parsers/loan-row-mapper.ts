const LOAN_KNOWN_HEADERS: Record<string, keyof Omit<MappedLoanFields, 'rawFields' | 'agency'>> = {
  'customer id': 'customerId',
  'customer name': 'customerName',
  'account no.': 'accountNumber',
  address: 'address',
  branch: 'branch',
  gender: 'gender',
  'phone no.': 'phone',
  ippis: 'ippisNumber',
  'loan amount': 'loanAmount',
  'principal bal.': 'principalBalance',
  'disbursement date': 'disbursementDate',
  'maturation date': 'maturationDate',
  'effective date': 'effectiveDate',
  'moratarium (day)': 'moratoriumDays',
  product: 'product',
  'linked account number': 'linkedAccountNumber',
  bvn: 'bvn',
  'interest rate': 'interestRatePercent',
  'account officer': 'accountOfficer',
  'has previously taken loan': 'hasPreviouslyTakenLoan',
};

const AGENCY_PREFIXES: Record<string, string> = {
  PF: 'NPF',
  CD: 'NSCDC',
  NI: 'IMMIGRATION',
  PR: 'CORRECTIONAL',
  NCS: 'CUSTOM',
};

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export interface MappedLoanFields {
  customerId: string;
  customerName: string;
  accountNumber: string;
  address: string | null;
  branch: string | null;
  gender: string | null;
  phone: string | null;
  ippisNumber: string;
  agency: string | null;
  loanAmount: number;
  principalBalance: number;
  disbursementDate: Date;
  maturationDate: Date;
  effectiveDate: Date | null;
  moratoriumDays: number | null;
  product: string;
  linkedAccountNumber: string | null;
  bvn: string | null;
  interestRatePercent: number;
  accountOfficer: string | null;
  hasPreviouslyTakenLoan: boolean;
  rawFields: Record<string, unknown>;
}

export interface LoanRowMappingSuccess {
  ok: true;
  record: MappedLoanFields;
  warnings: string[];
}

export interface LoanRowMappingFailure {
  ok: false;
  reason: string;
}

export type LoanRowMappingResult = LoanRowMappingSuccess | LoanRowMappingFailure;

export function isLoanRowMappingFailure(result: LoanRowMappingResult): result is LoanRowMappingFailure {
  return result.ok === false;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function requiredString(value: unknown): string | null {
  return stringOrNull(value);
}

function parseNumberCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseIntCell(value: unknown): number | null {
  const num = parseNumberCell(value);
  return num === null ? null : Math.trunc(num);
}

function parseBooleanFlag(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return value !== 0;
  const str = String(value).trim().toLowerCase();
  return str === '1' || str === 'true' || str === 'yes';
}

function parseLoanDateString(value: unknown): { date: Date | null; warning?: string } {
  if (value === null || value === undefined || value === '') return { date: null };
  if (value instanceof Date) return { date: value };
  const str = String(value).trim();
  const match = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = MONTH_ABBREVIATIONS[match[2].toLowerCase()];
    const year = parseInt(match[3], 10);
    if (month !== undefined) {
      const date = new Date(Date.UTC(year, month, day));
      if (!Number.isNaN(date.getTime())) return { date };
    }
  }
  const fallback = new Date(str);
  if (!Number.isNaN(fallback.getTime())) return { date: fallback };
  return { date: null, warning: `unparseable date value "${str}"` };
}

function deriveAgency(ippisNumber: string): { agency: string | null; warning?: string } {
  const upper = ippisNumber.toUpperCase();
  for (const prefix of Object.keys(AGENCY_PREFIXES)) {
    if (upper.startsWith(prefix)) {
      return { agency: AGENCY_PREFIXES[prefix] };
    }
  }
  return { agency: null, warning: `unrecognized IPPIS prefix in "${ippisNumber}"` };
}

export function mapLoanRow(rowByHeader: Record<string, unknown>): LoanRowMappingResult {
  const rawFields: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(rowByHeader)) {
    if (LOAN_KNOWN_HEADERS[header]) continue;
    if (value === null || value === undefined || value === '') continue;
    rawFields[header] = value instanceof Date ? value.toISOString() : value;
  }

  const customerId = requiredString(rowByHeader['customer id']);
  if (!customerId) return { ok: false, reason: 'missing Customer ID' };

  const customerName = requiredString(rowByHeader['customer name']);
  if (!customerName) return { ok: false, reason: 'missing Customer Name' };

  const accountNumber = requiredString(rowByHeader['account no.']);
  if (!accountNumber) return { ok: false, reason: 'missing Account No.' };

  const product = requiredString(rowByHeader['product']);
  if (!product) return { ok: false, reason: 'missing Product' };

  const ippisNumber = requiredString(rowByHeader['ippis']);
  if (!ippisNumber) return { ok: false, reason: 'missing IPPIS number' };

  const loanAmount = parseNumberCell(rowByHeader['loan amount']);
  if (loanAmount === null) return { ok: false, reason: 'missing or unparseable Loan Amount' };

  const principalBalance = parseNumberCell(rowByHeader['principal bal.']);
  if (principalBalance === null) return { ok: false, reason: 'missing or unparseable Principal Bal.' };

  const interestRatePercent = parseNumberCell(rowByHeader['interest rate']);
  if (interestRatePercent === null) return { ok: false, reason: 'missing or unparseable Interest Rate' };

  const disbursementDateResult = parseLoanDateString(rowByHeader['disbursement date']);
  if (!disbursementDateResult.date) return { ok: false, reason: 'missing or unparseable Disbursement Date' };

  const maturationDateResult = parseLoanDateString(rowByHeader['maturation date']);
  if (!maturationDateResult.date) return { ok: false, reason: 'missing or unparseable Maturation Date' };

  const warnings: string[] = [];
  const effectiveDateResult = parseLoanDateString(rowByHeader['effective date']);
  if (effectiveDateResult.warning) warnings.push(`effective date: ${effectiveDateResult.warning}`);

  const agencyResult = deriveAgency(ippisNumber);
  if (agencyResult.warning) warnings.push(agencyResult.warning);

  return {
    ok: true,
    warnings,
    record: {
      customerId,
      customerName,
      accountNumber,
      address: stringOrNull(rowByHeader['address']),
      branch: stringOrNull(rowByHeader['branch']),
      gender: stringOrNull(rowByHeader['gender']),
      phone: stringOrNull(rowByHeader['phone no.']),
      ippisNumber,
      agency: agencyResult.agency,
      loanAmount,
      principalBalance,
      disbursementDate: disbursementDateResult.date,
      maturationDate: maturationDateResult.date,
      effectiveDate: effectiveDateResult.date,
      moratoriumDays: parseIntCell(rowByHeader['moratarium (day)']),
      product,
      linkedAccountNumber: stringOrNull(rowByHeader['linked account number']),
      bvn: stringOrNull(rowByHeader['bvn']),
      interestRatePercent,
      accountOfficer: stringOrNull(rowByHeader['account officer']),
      hasPreviouslyTakenLoan: parseBooleanFlag(rowByHeader['has previously taken loan']),
      rawFields,
    },
  };
}

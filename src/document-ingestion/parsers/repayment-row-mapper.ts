export interface MappedRepaymentFields {
  staffId: string;
  elementName: string;
  elementDetail: string | null;
  amount: number;
  period: string | null;
  rawFields: Record<string, unknown>;
}

export interface RepaymentRowMappingSuccess {
  ok: true;
  record: MappedRepaymentFields;
  warnings: string[];
}

export interface RepaymentRowMappingFailure {
  ok: false;
  reason: string;
}

export type RepaymentRowMappingResult = RepaymentRowMappingSuccess | RepaymentRowMappingFailure;

export function isRepaymentRowMappingFailure(result: RepaymentRowMappingResult): result is RepaymentRowMappingFailure {
  return result.ok === false;
}

const MONTH_NAME_TO_NUMBER: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

export function normalizePeriod(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value).trim();

  const monthNameMatch = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (monthNameMatch) {
    const monthNum = MONTH_NAME_TO_NUMBER[monthNameMatch[1].toLowerCase()];
    if (monthNum) return `${monthNameMatch[2]}-${monthNum}`;
  }

  const compactMatch = str.match(/^(\d{4})(\d{2})$/);
  if (compactMatch) return `${compactMatch[1]}-${compactMatch[2]}`;

  if (/^\d{4}-\d{2}$/.test(str)) return str;

  return null;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function stringifyIdLikeValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(Math.trunc(value));
  return String(value).trim() || null;
}

function parseAmountCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function collectRawFields(rowByHeader: Record<string, unknown>, knownHeaders: Set<string>): Record<string, unknown> {
  const rawFields: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(rowByHeader)) {
    if (knownHeaders.has(header)) continue;
    if (value === null || value === undefined || value === '') continue;
    rawFields[header] = value instanceof Date ? value.toISOString() : value;
  }
  return rawFields;
}

// Every sheet uses the same columns. The first name in each list is the template's
// header; the rest are the names agencies' own files have used, so those still load.
// Specific names come before generic ones, as an agency file can hold both.
const STAFF_ID_HEADERS = ['staff id', 'ippis number', 'ippis no', 'staff number', 'employee_number'];
const AMOUNT_HEADERS = ['amount', 'cit microfinance', 'result_value sum', 'deduction'];
const AMOUNT_LOOKUP_ORDER = ['cit microfinance', 'result_value sum', 'deduction', 'amount'];
const STAFF_ID_LOOKUP_ORDER = ['ippis number', 'ippis no', 'staff number', 'employee_number', 'staff id'];
const DEFAULT_ELEMENT_NAME = 'LOAN_REPAYMENT';

const KNOWN_HEADERS = new Set([...STAFF_ID_HEADERS, ...AMOUNT_HEADERS, 'element', 'period', 'loan type']);

function firstPresent(rowByHeader: Record<string, unknown>, headers: string[]): unknown {
  const header = headers.find((name) => {
    const value = rowByHeader[name];
    return value !== null && value !== undefined && value !== '';
  });
  return header ? rowByHeader[header] : null;
}

export function isRepaymentHeaderRow(headers: Array<string | null>): boolean {
  return STAFF_ID_HEADERS.some((name) => headers.includes(name)) && AMOUNT_HEADERS.some((name) => headers.includes(name));
}

export function mapRepaymentRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(firstPresent(rowByHeader, STAFF_ID_LOOKUP_ORDER));
  if (!staffId) return { ok: false, reason: 'missing Staff ID' };

  const amount = parseAmountCell(firstPresent(rowByHeader, AMOUNT_LOOKUP_ORDER));
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: stringOrNull(rowByHeader['element']) ?? DEFAULT_ELEMENT_NAME,
      elementDetail: stringOrNull(rowByHeader['loan type']),
      amount,
      period: normalizePeriod(rowByHeader['period']),
      rawFields: collectRawFields(rowByHeader, KNOWN_HEADERS),
    },
  };
}

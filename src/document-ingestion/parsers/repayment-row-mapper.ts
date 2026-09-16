export type AgencyKey = 'NPF' | 'NSCDC' | 'IMMIGRATION' | 'CORRECTIONAL' | 'CUSTOM' | 'LASG';

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

const NPF_KNOWN_HEADERS = new Set(['staff id', 'amount', 'element', 'period']);

function mapNpfRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['staff id']);
  if (!staffId) return { ok: false, reason: 'missing Staff ID' };

  const amount = parseAmountCell(rowByHeader['amount']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  const elementName = stringOrNull(rowByHeader['element']);
  if (!elementName) return { ok: false, reason: 'missing Element' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName,
      elementDetail: null,
      amount,
      period: normalizePeriod(rowByHeader['period']),
      rawFields: collectRawFields(rowByHeader, NPF_KNOWN_HEADERS),
    },
  };
}

const NSCDC_KNOWN_HEADERS = new Set(['ippis no', 'amount']);

function mapNscdcRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['ippis no']);
  if (!staffId) return { ok: false, reason: 'missing IPPIS NO' };

  const amount = parseAmountCell(rowByHeader['amount']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, NSCDC_KNOWN_HEADERS),
    },
  };
}

const IMMIGRATION_KNOWN_HEADERS = new Set(['ippis number', 'cit microfinance']);

function mapImmigrationRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['ippis number']);
  if (!staffId) return { ok: false, reason: 'missing IPPIS NUMBER' };

  const amount = parseAmountCell(rowByHeader['cit microfinance']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable CIT MICROFINANCE amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, IMMIGRATION_KNOWN_HEADERS),
    },
  };
}

const CORRECTIONAL_KNOWN_HEADERS = new Set(['ippis number', 'amount']);

function mapCorrectionalRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['ippis number']);
  if (!staffId) return { ok: false, reason: 'missing IPPIS NUMBER' };

  const amount = parseAmountCell(rowByHeader['amount']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Amount' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, CORRECTIONAL_KNOWN_HEADERS),
    },
  };
}

const CUSTOM_KNOWN_HEADERS = new Set(['period', 'staff number', 'loan type', 'deduction']);

function mapCustomRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['staff number']);
  if (!staffId) return { ok: false, reason: 'missing Staff Number' };

  const amount = parseAmountCell(rowByHeader['deduction']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Deduction' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: stringOrNull(rowByHeader['loan type']),
      amount,
      period: normalizePeriod(rowByHeader['period']),
      rawFields: collectRawFields(rowByHeader, CUSTOM_KNOWN_HEADERS),
    },
  };
}

const LASG_KNOWN_HEADERS = new Set(['employee_number', 'result_value sum']);

function mapLasgRow(rowByHeader: Record<string, unknown>): RepaymentRowMappingResult {
  const staffId = stringifyIdLikeValue(rowByHeader['employee_number']);
  if (!staffId) return { ok: false, reason: 'missing Employee_Number' };

  const amount = parseAmountCell(rowByHeader['result_value sum']);
  if (amount === null) return { ok: false, reason: 'missing or unparseable Result_Value SUM' };

  return {
    ok: true,
    warnings: [],
    record: {
      staffId,
      elementName: 'LOAN_REPAYMENT',
      elementDetail: null,
      amount,
      period: null,
      rawFields: collectRawFields(rowByHeader, LASG_KNOWN_HEADERS),
    },
  };
}

export const AGENCY_ROW_MAPPERS: Record<AgencyKey, (rowByHeader: Record<string, unknown>) => RepaymentRowMappingResult> = {
  NPF: mapNpfRow,
  NSCDC: mapNscdcRow,
  IMMIGRATION: mapImmigrationRow,
  CORRECTIONAL: mapCorrectionalRow,
  CUSTOM: mapCustomRow,
  LASG: mapLasgRow,
};

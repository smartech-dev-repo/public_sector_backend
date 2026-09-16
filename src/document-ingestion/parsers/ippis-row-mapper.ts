const IPPIS_KNOWN_HEADERS: Record<string, keyof Omit<MappedIppisFields, 'rawFields'>> = {
  'staff id': 'staffId',
  'employee name': 'employeeName',
  'employee status': 'employeeStatus',
  'hire date': 'hireDate',
  'date of birth': 'dateOfBirth',
  'marital status': 'maritalStatus',
  gender: 'gender',
  'job title': 'jobTitle',
  department: 'department',
  'sub organization': 'subOrganization',
  grade: 'grade',
  step: 'step',
  salary: 'salary',
  'telephone number': 'phone',
  'bank name': 'bankName',
  'account number': 'accountNumber',
  'pfa name': 'pfaName',
  'pin number': 'pinNumber',
  'date terminated': 'dateTerminated',
  bvn: 'bvn',
  'legacy id': 'legacyId',
};

export interface MappedIppisFields {
  staffId: string;
  employeeName: string;
  employeeStatus: string | null;
  hireDate: Date | null;
  dateOfBirth: Date | null;
  maritalStatus: string | null;
  gender: string | null;
  jobTitle: string | null;
  department: string | null;
  subOrganization: string | null;
  grade: string | null;
  step: string | null;
  salary: number | null;
  phone: string | null;
  bankName: string | null;
  accountNumber: string | null;
  pfaName: string | null;
  pinNumber: string | null;
  dateTerminated: Date | null;
  bvn: string | null;
  legacyId: string | null;
  rawFields: Record<string, unknown>;
}

export interface RowMappingSuccess {
  ok: true;
  record: MappedIppisFields;
  warnings: string[];
}

export interface RowMappingFailure {
  ok: false;
  reason: string;
}

export type RowMappingResult = RowMappingSuccess | RowMappingFailure;

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value).trim() || null;
}

function stringifyIdLikeValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return String(Math.trunc(value));
  return String(value).trim() || null;
}

function parseSalaryCell(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseDateCell(value: unknown): { date: Date | null; warning?: string } {
  if (value === null || value === undefined || value === '') return { date: null };
  if (value instanceof Date) return { date: value };
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return { date: null, warning: `unparseable date value "${value}"` };
  }
  return { date: parsed };
}

export function mapIppisRow(rowByHeader: Record<string, unknown>): RowMappingResult {
  const rawFields: Record<string, unknown> = {};
  for (const [header, value] of Object.entries(rowByHeader)) {
    if (IPPIS_KNOWN_HEADERS[header]) continue;
    if (value === null || value === undefined || value === '') continue;
    rawFields[header] = value instanceof Date ? value.toISOString() : value;
  }

  const staffId = stringifyIdLikeValue(rowByHeader['staff id']);
  if (!staffId) {
    return { ok: false, reason: 'missing Staff ID' };
  }

  const employeeName = stringOrNull(rowByHeader['employee name']);
  if (!employeeName) {
    return { ok: false, reason: 'missing Employee Name' };
  }

  const bvn = stringifyIdLikeValue(rowByHeader['bvn']);
  if (bvn !== null && bvn.length !== 11) {
    return { ok: false, reason: `BVN "${bvn}" is not 11 digits` };
  }

  const warnings: string[] = [];
  const hireDate = parseDateCell(rowByHeader['hire date']);
  if (hireDate.warning) warnings.push(`hire date: ${hireDate.warning}`);
  const dateOfBirth = parseDateCell(rowByHeader['date of birth']);
  if (dateOfBirth.warning) warnings.push(`date of birth: ${dateOfBirth.warning}`);
  const dateTerminated = parseDateCell(rowByHeader['date terminated']);
  if (dateTerminated.warning) warnings.push(`date terminated: ${dateTerminated.warning}`);

  return {
    ok: true,
    warnings,
    record: {
      staffId,
      employeeName,
      employeeStatus: stringOrNull(rowByHeader['employee status']),
      hireDate: hireDate.date,
      dateOfBirth: dateOfBirth.date,
      maritalStatus: stringOrNull(rowByHeader['marital status']),
      gender: stringOrNull(rowByHeader['gender']),
      jobTitle: stringOrNull(rowByHeader['job title']),
      department: stringOrNull(rowByHeader['department']),
      subOrganization: stringOrNull(rowByHeader['sub organization']),
      grade: stringOrNull(rowByHeader['grade']),
      step: stringOrNull(rowByHeader['step']),
      salary: parseSalaryCell(rowByHeader['salary']),
      phone: stringifyIdLikeValue(rowByHeader['telephone number']),
      bankName: stringOrNull(rowByHeader['bank name']),
      accountNumber: stringOrNull(rowByHeader['account number']),
      pfaName: stringOrNull(rowByHeader['pfa name']),
      pinNumber: stringifyIdLikeValue(rowByHeader['pin number']),
      dateTerminated: dateTerminated.date,
      bvn,
      legacyId: stringOrNull(rowByHeader['legacy id']),
      rawFields,
    },
  };
}

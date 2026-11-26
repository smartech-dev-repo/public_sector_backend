import {
  isRepaymentHeaderRow,
  mapRepaymentRow,
  isRepaymentRowMappingFailure,
  normalizePeriod,
  RepaymentRowMappingFailure,
  RepaymentRowMappingResult,
  RepaymentRowMappingSuccess,
} from './repayment-row-mapper';

function assertSuccess(result: RepaymentRowMappingResult): asserts result is RepaymentRowMappingSuccess {
  if (!result.ok) throw new Error(`expected success but got failure: ${(result as RepaymentRowMappingFailure).reason}`);
}

function assertFailure(result: RepaymentRowMappingResult): asserts result is RepaymentRowMappingFailure {
  if (result.ok) throw new Error('expected failure but got success');
}

describe('normalizePeriod', () => {
  it('normalizes "MONTH YYYY" style values', () => {
    expect(normalizePeriod('SEPTEMBER 2024')).toBe('2024-09');
    expect(normalizePeriod('january 2025')).toBe('2025-01');
  });

  it('normalizes "YYYYMM" style values', () => {
    expect(normalizePeriod('202512')).toBe('2025-12');
  });

  it('passes through already-normalized "YYYY-MM" values', () => {
    expect(normalizePeriod('2024-11')).toBe('2024-11');
  });

  it('returns null for missing or unparseable values', () => {
    expect(normalizePeriod('')).toBeNull();
    expect(normalizePeriod(undefined)).toBeNull();
    expect(normalizePeriod('not a period')).toBeNull();
  });
});

describe('mapRepaymentRow', () => {
  const row = { 'staff id': 'PF1', amount: 5000 };

  it('needs only Staff ID and Amount, and defaults the element', () => {
    const result = mapRepaymentRow(row);
    assertSuccess(result);
    expect(result.record).toEqual(
      expect.objectContaining({ staffId: 'PF1', amount: 5000, elementName: 'LOAN_REPAYMENT', elementDetail: null, period: null }),
    );
  });

  it('reads the optional columns', () => {
    const result = mapRepaymentRow({ ...row, element: 'CIT LOAN', period: 'October 2026', 'loan type': 'SALARY' });
    assertSuccess(result);
    expect(result.record).toEqual(
      expect.objectContaining({ elementName: 'CIT LOAN', elementDetail: 'SALARY', period: '2026-10' }),
    );
  });

  it('keeps an unknown column in rawFields, including Employee Name', () => {
    const result = mapRepaymentRow({ ...row, 'employee name': 'Ada', extra: 'x' });
    assertSuccess(result);
    expect(result.record.rawFields).toEqual({ 'employee name': 'Ada', extra: 'x' });
  });

  it.each([
    ['NSCDC', { 'ippis no': 'A1', amount: 10 }],
    ['IMMIGRATION', { 'ippis number': 'A1', 'cit microfinance': 10 }],
    ['CORRECTIONAL', { 'ippis number': 'A1', amount: 10 }],
    ['CUSTOM', { 'staff number': 'A1', deduction: 10 }],
    ['LASG', { employee_number: 'A1', 'result_value sum': 10 }],
  ])('still reads the old %s column names', (_agency, oldRow) => {
    const result = mapRepaymentRow(oldRow);
    assertSuccess(result);
    expect(result.record).toEqual(expect.objectContaining({ staffId: 'A1', amount: 10 }));
  });

  it('prefers the specific column when an agency file has both', () => {
    const result = mapRepaymentRow({ 'ippis number': 'A1', 'staff id': 'OTHER', 'cit microfinance': 10, amount: 999 });
    assertSuccess(result);
    expect(result.record).toEqual(expect.objectContaining({ staffId: 'A1', amount: 10 }));
  });

  it('rejects a missing Staff ID or an unusable Amount', () => {
    assertFailure(mapRepaymentRow({ amount: 10 }));
    assertFailure(mapRepaymentRow({ 'staff id': 'A1', amount: 'bad' }));
  });
});

describe('isRepaymentHeaderRow', () => {
  it('needs a staff column and an amount column', () => {
    expect(isRepaymentHeaderRow(['staff id', 'amount'])).toBe(true);
    expect(isRepaymentHeaderRow(['employee_number', 'employee_name', 'result_value sum'])).toBe(true);
    expect(isRepaymentHeaderRow(['staff id', null])).toBe(false);
  });
});

describe('isRepaymentRowMappingFailure', () => {
  it('narrows correctly', () => {
    expect(isRepaymentRowMappingFailure(mapRepaymentRow({}))).toBe(true);
    expect(isRepaymentRowMappingFailure(mapRepaymentRow({ 'staff id': 'X', amount: 1 }))).toBe(false);
  });
});

import {
  AGENCY_ROW_MAPPERS,
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

describe('mapNpfRow', () => {
  const baseRow = {
    'staff id': 'NPF/1',
    check: 'OK',
    'legacy id': 'L1',
    'full name': 'TEST STAFF',
    element: 'PERSONAL LOAN',
    amount: 5000,
    period: 'SEPTEMBER 2024',
    command: 'Zone 2',
    'reason/comments': '',
  };

  it('maps a full row', () => {
    const result = AGENCY_ROW_MAPPERS.NPF(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('NPF/1');
    expect(result.record.elementName).toBe('PERSONAL LOAN');
    expect(result.record.amount).toBe(5000);
    expect(result.record.period).toBe('2024-09');
    expect(result.record.elementDetail).toBeNull();
    expect(result.record.rawFields).toEqual({ check: 'OK', 'legacy id': 'L1', 'full name': 'TEST STAFF', command: 'Zone 2' });
  });

  it('rejects a row missing Staff ID', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NPF({ ...baseRow, 'staff id': '' }));
  });

  it('rejects a row missing or unparseable Amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NPF({ ...baseRow, amount: 'not-a-number' }));
  });

  it('rejects a row missing Element (the natural-key discriminator for NPF)', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NPF({ ...baseRow, element: '' }));
  });
});

describe('mapNscdcRow', () => {
  const baseRow = { 'employee name': 'TEST STAFF', 'ippis no': 'CD1', amount: 3000 };

  it('maps a full row with the fixed elementName sentinel', () => {
    const result = AGENCY_ROW_MAPPERS.NSCDC(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('CD1');
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.amount).toBe(3000);
    expect(result.record.period).toBeNull();
    expect(result.record.rawFields).toEqual({ 'employee name': 'TEST STAFF' });
  });

  it('rejects a row missing IPPIS NO', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NSCDC({ ...baseRow, 'ippis no': '' }));
  });

  it('rejects a row missing or unparseable Amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.NSCDC({ ...baseRow, amount: 'bad' }));
  });
});

describe('mapImmigrationRow', () => {
  const baseRow = {
    surname: 'TEST',
    'other names': 'STAFF',
    'ippis number': 'NI1',
    staffid: 'INTERNAL-1',
    'cit microfinance': 2000,
  };

  it('maps a full row, preferring IPPIS NUMBER over StaffID', () => {
    const result = AGENCY_ROW_MAPPERS.IMMIGRATION(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('NI1');
    expect(result.record.amount).toBe(2000);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.rawFields).toEqual({ surname: 'TEST', 'other names': 'STAFF', staffid: 'INTERNAL-1' });
  });

  it('rejects a row missing IPPIS NUMBER', () => {
    assertFailure(AGENCY_ROW_MAPPERS.IMMIGRATION({ ...baseRow, 'ippis number': '' }));
  });

  it('rejects a row missing or unparseable CIT MICROFINANCE amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.IMMIGRATION({ ...baseRow, 'cit microfinance': 'bad' }));
  });
});

describe('mapCorrectionalRow', () => {
  const baseRow = {
    'surname other names': 'TEST STAFF',
    'ippis number': 'PR1',
    staffid: 'INTERNAL-2',
    amount: 4000,
    'account number': 'ACC-1',
    bank: 'TEST BANK',
    'element name': 'PERSONAL LOAN',
    'deduction beneficiary': 'MONEYFIELD',
  };

  it('maps a full row, preferring IPPIS NUMBER over StaffID', () => {
    const result = AGENCY_ROW_MAPPERS.CORRECTIONAL(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('PR1');
    expect(result.record.amount).toBe(4000);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.rawFields).toEqual({
      'surname other names': 'TEST STAFF',
      staffid: 'INTERNAL-2',
      'account number': 'ACC-1',
      bank: 'TEST BANK',
      'element name': 'PERSONAL LOAN',
      'deduction beneficiary': 'MONEYFIELD',
    });
  });

  it('rejects a row missing IPPIS NUMBER', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CORRECTIONAL({ ...baseRow, 'ippis number': '' }));
  });

  it('rejects a row missing or unparseable Amount', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CORRECTIONAL({ ...baseRow, amount: 'bad' }));
  });
});

describe('mapCustomRow', () => {
  const baseRow = {
    's/n': 1,
    period: '202412',
    'staff number': 'CUST-1',
    'staff name': 'TEST STAFF',
    'loan type': 'SALARY ADVANCE',
    deduction: 1500,
  };

  it('maps a full row, putting Loan Type into elementDetail', () => {
    const result = AGENCY_ROW_MAPPERS.CUSTOM(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('CUST-1');
    expect(result.record.amount).toBe(1500);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.elementDetail).toBe('SALARY ADVANCE');
    expect(result.record.period).toBe('2024-12');
    expect(result.record.rawFields).toEqual({ 's/n': 1, 'staff name': 'TEST STAFF' });
  });

  it('rejects a row missing Staff Number', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CUSTOM({ ...baseRow, 'staff number': '' }));
  });

  it('rejects a row missing or unparseable Deduction', () => {
    assertFailure(AGENCY_ROW_MAPPERS.CUSTOM({ ...baseRow, deduction: 'bad' }));
  });
});

describe('mapLasgRow', () => {
  const baseRow = {
    employee_number: 'LASG-1',
    employee_name: 'TEST STAFF',
    ministry_name: 'MINISTRY OF TEST',
    grade_level: '08',
    step: '3',
    'result_value sum': 2500,
    element_name: 'LOAN',
  };

  it('maps a full row with the fixed elementName sentinel', () => {
    const result = AGENCY_ROW_MAPPERS.LASG(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('LASG-1');
    expect(result.record.amount).toBe(2500);
    expect(result.record.elementName).toBe('LOAN_REPAYMENT');
    expect(result.record.period).toBeNull();
    expect(result.record.rawFields).toEqual({
      employee_name: 'TEST STAFF',
      ministry_name: 'MINISTRY OF TEST',
      grade_level: '08',
      step: '3',
      element_name: 'LOAN',
    });
  });

  it('rejects a row missing Employee_Number', () => {
    assertFailure(AGENCY_ROW_MAPPERS.LASG({ ...baseRow, employee_number: '' }));
  });

  it('rejects a row missing or unparseable Result_Value SUM', () => {
    assertFailure(AGENCY_ROW_MAPPERS.LASG({ ...baseRow, 'result_value sum': 'bad' }));
  });
});

describe('isRepaymentRowMappingFailure', () => {
  it('narrows correctly', () => {
    expect(isRepaymentRowMappingFailure(AGENCY_ROW_MAPPERS.NSCDC({}))).toBe(true);
    expect(isRepaymentRowMappingFailure(AGENCY_ROW_MAPPERS.NSCDC({ 'ippis no': 'X', amount: 1 }))).toBe(false);
  });
});

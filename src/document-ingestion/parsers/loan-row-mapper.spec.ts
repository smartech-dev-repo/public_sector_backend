import {
  isLoanRowMappingFailure,
  LoanRowMappingFailure,
  LoanRowMappingResult,
  LoanRowMappingSuccess,
  mapLoanRow,
} from './loan-row-mapper';

function assertSuccess(result: LoanRowMappingResult): asserts result is LoanRowMappingSuccess {
  if (!result.ok) throw new Error(`expected success but got failure: ${(result as LoanRowMappingFailure).reason}`);
}

function assertFailure(result: LoanRowMappingResult): asserts result is LoanRowMappingFailure {
  if (result.ok) throw new Error('expected failure but got success');
}

describe('mapLoanRow', () => {
  const baseRow = {
    'customer id': '025069',
    'customer name': 'TEST CUSTOMER',
    'account no.': '01290013294025069',
    address: 'TEST ADDRESS',
    branch: 'Head Office',
    gender: 'Male',
    'phone no.': '08000000000',
    'loan amount': 500000,
    'principal bal.': 0,
    'disbursement date': '08-Aug-2024',
    'maturation date': '30-May-2026',
    'effective date': '07-Oct-2024',
    'moratarium (day)': '60',
    product: 'NIGERIAN CIVIL DEFENCE - PERSONAL LOAN',
    'linked account number': '01290011240025069',
    bvn: '22209498402',
    'interest rate': 42,
    'account officer': 'TEST OFFICER',
    'has previously taken loan': 1,
    ippis: 'CD7038686',
  };

  it('maps a full row into MappedLoanFields', () => {
    const result = mapLoanRow(baseRow);
    assertSuccess(result);
    expect(result.record.customerId).toBe('025069');
    expect(result.record.customerName).toBe('TEST CUSTOMER');
    expect(result.record.loanAmount).toBe(500000);
    expect(result.record.disbursementDate).toEqual(new Date(Date.UTC(2024, 7, 8)));
    expect(result.record.maturationDate).toEqual(new Date(Date.UTC(2026, 4, 30)));
    expect(result.record.moratoriumDays).toBe(60);
    expect(result.record.hasPreviouslyTakenLoan).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('derives agency from the IPPIS prefix', () => {
    expect(mapLoanRow({ ...baseRow, ippis: 'CD7038686' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'NSCDC' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'PF0305850' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'NPF' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'NI1234567' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'IMMIGRATION' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'PR1234567' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'CORRECTIONAL' }) }),
    );
    expect(mapLoanRow({ ...baseRow, ippis: 'NCS123456' })).toEqual(
      expect.objectContaining({ ok: true, record: expect.objectContaining({ agency: 'CUSTOM' }) }),
    );
  });

  it('sets agency to null with a warning for an unrecognized IPPIS prefix, without rejecting the row', () => {
    const result = mapLoanRow({ ...baseRow, ippis: 'ZZ9999999' });
    assertSuccess(result);
    expect(result.record.agency).toBeNull();
    expect(result.warnings[0]).toMatch(/unrecognized IPPIS prefix/);
  });

  it('captures unknown headers into rawFields', () => {
    const result = mapLoanRow({
      ...baseRow,
      'group name': 'TEST GROUP',
      'ministries, departments and agencies': 'NSCDC',
      'restructured disbursement date': '',
      'guarantor 1': 'TEST GUARANTOR',
    });
    assertSuccess(result);
    expect(result.record.rawFields).toEqual({
      'group name': 'TEST GROUP',
      'ministries, departments and agencies': 'NSCDC',
      'guarantor 1': 'TEST GUARANTOR',
    });
  });

  it.each([
    ['customer id', 'customerId'],
    ['customer name', 'customerName'],
    ['account no.', 'accountNumber'],
    ['product', 'product'],
    ['ippis', 'ippisNumber'],
  ])('rejects a row missing %s', (header) => {
    const result = mapLoanRow({ ...baseRow, [header]: '' });
    assertFailure(result);
  });

  it.each([
    ['loan amount', 'loanAmount'],
    ['principal bal.', 'principalBalance'],
    ['interest rate', 'interestRatePercent'],
  ])('rejects a row with a missing or unparseable %s', (header) => {
    const result = mapLoanRow({ ...baseRow, [header]: 'not-a-number' });
    assertFailure(result);
  });

  it.each([
    ['disbursement date', 'disbursementDate'],
    ['maturation date', 'maturationDate'],
  ])('rejects a row with a missing or unparseable %s', (header) => {
    const result = mapLoanRow({ ...baseRow, [header]: 'not-a-date' });
    assertFailure(result);
  });

  it('records a warning and nulls the field for an unparseable non-required date, without rejecting the row', () => {
    const result = mapLoanRow({ ...baseRow, 'effective date': 'not-a-date' });
    assertSuccess(result);
    expect(result.record.effectiveDate).toBeNull();
    expect(result.warnings.some((w) => w.includes('effective date'))).toBe(true);
  });

  it('parses "0"/missing has-previously-taken-loan as false', () => {
    const zero = mapLoanRow({ ...baseRow, 'has previously taken loan': 0 });
    assertSuccess(zero);
    expect(zero.record.hasPreviouslyTakenLoan).toBe(false);

    const { 'has previously taken loan': _omit, ...rowWithoutFlag } = baseRow;
    const missing = mapLoanRow(rowWithoutFlag);
    assertSuccess(missing);
    expect(missing.record.hasPreviouslyTakenLoan).toBe(false);
  });

  it('isLoanRowMappingFailure narrows correctly', () => {
    const failure = mapLoanRow({ ...baseRow, 'customer id': '' });
    expect(isLoanRowMappingFailure(failure)).toBe(true);
    const success = mapLoanRow(baseRow);
    expect(isLoanRowMappingFailure(success)).toBe(false);
  });
});

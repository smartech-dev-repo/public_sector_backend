import { mapIppisRow, RowMappingFailure, RowMappingResult, RowMappingSuccess } from './ippis-row-mapper';

function assertSuccess(result: RowMappingResult): asserts result is RowMappingSuccess {
  if (!result.ok) throw new Error(`expected success but got failure: ${(result as RowMappingFailure).reason}`);
}

function assertFailure(result: RowMappingResult): asserts result is RowMappingFailure {
  if (result.ok) throw new Error('expected failure but got success');
}

describe('mapIppisRow', () => {
  const baseRow = {
    'staff id': 'NPF/1234',
    'employee name': 'Jane Doe',
    'employee status': 'Active',
    'hire date': new Date('2020-01-15'),
    'date of birth': new Date('1990-05-20'),
    'marital status': 'Single',
    gender: 'Female',
    'job title': 'Sergeant',
    'sub organization': 'Zone 2',
    grade: '08',
    step: '3',
    'telephone number': 8031234567,
    'bank name': 'GTBank',
    'account number': '0123456789',
    bvn: 22345678901,
  };

  it('maps a full row into MappedIppisFields', () => {
    const result = mapIppisRow(baseRow);
    assertSuccess(result);
    expect(result.record.staffId).toBe('NPF/1234');
    expect(result.record.employeeName).toBe('Jane Doe');
    expect(result.record.hireDate).toEqual(new Date('2020-01-15'));
    expect(result.record.bvn).toBe('22345678901');
    expect(result.record.phone).toBe('8031234567');
    expect(result.record.department).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('captures unknown headers into rawFields', () => {
    const result = mapIppisRow({
      ...baseRow,
      'email address': 'jane@example.com',
      'assignment status': 'Confirmed',
      'grade category': 'Uniform',
    });
    assertSuccess(result);
    expect(result.record.rawFields).toEqual({
      'email address': 'jane@example.com',
      'assignment status': 'Confirmed',
      'grade category': 'Uniform',
    });
  });

  it('rejects a row missing Staff ID', () => {
    const result = mapIppisRow({ ...baseRow, 'staff id': '' });
    assertFailure(result);
    expect(result.reason).toMatch(/Staff ID/);
  });

  it('rejects a row missing Employee Name', () => {
    const result = mapIppisRow({ ...baseRow, 'employee name': undefined });
    assertFailure(result);
    expect(result.reason).toMatch(/Employee Name/);
  });

  it('rejects a row with a BVN that is not 11 digits', () => {
    const result = mapIppisRow({ ...baseRow, bvn: 123 });
    assertFailure(result);
    expect(result.reason).toMatch(/BVN/);
  });

  it('allows a missing BVN (not every record is guaranteed to have one)', () => {
    const { bvn: _omit, ...rowWithoutBvn } = baseRow;
    const result = mapIppisRow(rowWithoutBvn);
    assertSuccess(result);
    expect(result.record.bvn).toBeNull();
  });

  it('records a warning and nulls the field for an unparseable date, without rejecting the row', () => {
    const result = mapIppisRow({ ...baseRow, 'hire date': 'not-a-date' });
    assertSuccess(result);
    expect(result.record.hireDate).toBeNull();
    expect(result.warnings[0]).toMatch(/hire date/);
  });

  it('parses a numeric salary and leaves it null when absent', () => {
    const withSalary = mapIppisRow({ ...baseRow, salary: 250000 });
    assertSuccess(withSalary);
    expect(withSalary.record.salary).toBe(250000);

    const withoutSalary = mapIppisRow(baseRow);
    assertSuccess(withoutSalary);
    expect(withoutSalary.record.salary).toBeNull();
  });
});

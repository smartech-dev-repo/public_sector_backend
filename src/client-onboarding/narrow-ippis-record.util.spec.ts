import { narrowIppisRecord } from './narrow-ippis-record.util';

describe('narrowIppisRecord', () => {
  const fullRecord = {
    agency: 'NPF',
    staffId: 'S1',
    employeeName: 'Jane Doe',
    employeeStatus: 'ACTIVE',
    hireDate: null,
    department: 'IT',
    grade: 'GL07',
    bankName: 'GTBank',
    accountNumber: '0123456789',
    bvn: '12345678901',
    salary: 500000,
    pinNumber: 'secret-pin',
  };

  it('returns undefined for null/undefined input', () => {
    expect(narrowIppisRecord(null)).toBeUndefined();
    expect(narrowIppisRecord(undefined)).toBeUndefined();
  });

  it('strips sensitive fields (bvn, salary, pinNumber) not in the whitelist', () => {
    const result = narrowIppisRecord(fullRecord);
    expect(result).not.toHaveProperty('bvn');
    expect(result).not.toHaveProperty('salary');
    expect(result).not.toHaveProperty('pinNumber');
  });

  it('keeps exactly the whitelisted fields', () => {
    expect(narrowIppisRecord(fullRecord)).toEqual({
      agency: 'NPF',
      staffId: 'S1',
      employeeName: 'Jane Doe',
      employeeStatus: 'ACTIVE',
      hireDate: null,
      department: 'IT',
      grade: 'GL07',
      bankName: 'GTBank',
      accountNumber: '0123456789',
    });
  });
});

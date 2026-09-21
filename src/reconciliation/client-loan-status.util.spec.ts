import { computeClientLoanStatus } from './client-loan-status.util';
import { VarianceStatus } from '../generated/prisma/client';

describe('computeClientLoanStatus', () => {
  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const past = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);

  it('returns CLOSED when the principal balance is paid off, regardless of maturity', () => {
    expect(computeClientLoanStatus({ principalBalance: 0, maturationDate: future }, null)).toBe('CLOSED');
    expect(computeClientLoanStatus({ principalBalance: 0, maturationDate: past }, VarianceStatus.UNDER_PAID)).toBe(
      'CLOSED',
    );
  });

  it('returns DEFAULT when maturity has passed and a balance remains, even with no variance history', () => {
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: past }, null)).toBe('DEFAULT');
  });

  it('returns DEFAULT when the most recent variance is UNDER_PAID or NO_DEDUCTION_FOUND, even before maturity', () => {
    expect(
      computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.UNDER_PAID),
    ).toBe('DEFAULT');
    expect(
      computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.NO_DEDUCTION_FOUND),
    ).toBe('DEFAULT');
  });

  it('returns ACTIVE when not past maturity and the most recent variance is healthy', () => {
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.MATCHED)).toBe(
      'ACTIVE',
    );
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, VarianceStatus.OVER_PAID)).toBe(
      'ACTIVE',
    );
    expect(computeClientLoanStatus({ principalBalance: 5000, maturationDate: future }, null)).toBe('ACTIVE');
  });
});

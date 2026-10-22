import { computeExpectedInstallment, monthsBetween } from './amortization.util';

describe('computeExpectedInstallment', () => {
  it('divides the principal evenly across the term when the rate is 0%', () => {
    const result = computeExpectedInstallment(120000, 0, new Date('2025-01-01'), new Date('2026-01-01'));
    expect(result).toBeCloseTo(10000, 2);
  });

  it('matches the exact single-period formula (principal plus one month of interest)', () => {
    const result = computeExpectedInstallment(100000, 12, new Date('2025-01-01'), new Date('2025-02-01'));
    expect(result).toBeCloseTo(101000, 2);
  });

  it('produces a higher installment than the zero-rate case when interest applies', () => {
    const zeroRate = computeExpectedInstallment(1200000, 0, new Date('2025-01-01'), new Date('2026-01-01'));
    const withRate = computeExpectedInstallment(1200000, 12, new Date('2025-01-01'), new Date('2026-01-01'));
    expect(withRate).toBeGreaterThan(zeroRate);
  });

  it('returns the full loan amount for a zero-length term', () => {
    const result = computeExpectedInstallment(50000, 10, new Date('2025-01-01'), new Date('2025-01-01'));
    expect(result).toBe(50000);
  });
});

describe('monthsBetween', () => {
  it('counts the calendar months between two dates', () => {
    expect(monthsBetween(new Date(2026, 0, 1), new Date(2026, 5, 1))).toBe(5);
  });

  it('spans a year boundary', () => {
    expect(monthsBetween(new Date(2025, 10, 1), new Date(2026, 1, 1))).toBe(3);
  });

  it('returns 0 for the same month', () => {
    expect(monthsBetween(new Date(2026, 2, 1), new Date(2026, 2, 28))).toBe(0);
  });
});

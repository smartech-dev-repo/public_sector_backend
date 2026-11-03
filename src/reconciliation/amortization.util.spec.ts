import {
  computeExpectedInstallment,
  monthsBetween,
  paybackRatio,
  principalShareOfPayment,
} from './amortization.util';

describe('paybackRatio', () => {
  it('is 1 + rate × tenor as a decimal', () => {
    expect(paybackRatio(5, 6)).toBeCloseTo(1.3, 10);
    expect(paybackRatio(2, 12)).toBeCloseTo(1.24, 10);
    expect(paybackRatio(0, 12)).toBe(1);
  });
});

describe('computeExpectedInstallment (flat monthly rate)', () => {
  it('divides the principal evenly across the term when the rate is 0%', () => {
    const result = computeExpectedInstallment(
      120000,
      0,
      new Date('2025-01-01'),
      new Date('2026-01-01'),
    );
    expect(result).toBeCloseTo(10000, 2);
  });

  it('adds rate × tenor of interest, spread over the term', () => {
    // ₦600,000 at 5% a month over 6 months: 600,000 × 1.30 / 6 = 130,000.
    const result = computeExpectedInstallment(
      600000,
      5,
      new Date(2025, 0, 1),
      new Date(2025, 6, 1),
    );
    expect(result).toBeCloseTo(130000, 2);
  });

  it('treats the rate as monthly, not yearly', () => {
    // One month at 12%: 100,000 × 1.12.
    const result = computeExpectedInstallment(
      100000,
      12,
      new Date(2025, 0, 1),
      new Date(2025, 1, 1),
    );
    expect(result).toBeCloseTo(112000, 2);
  });

  it('spreads a charge added to repayment across the term', () => {
    const result = computeExpectedInstallment(
      120000,
      0,
      new Date(2025, 0, 1),
      new Date(2026, 0, 1),
      12000,
    );
    expect(result).toBeCloseTo(11000, 2);
  });

  it('returns the full loan amount for a zero-length term', () => {
    const result = computeExpectedInstallment(
      50000,
      10,
      new Date('2025-01-01'),
      new Date('2025-01-01'),
    );
    expect(result).toBe(50000);
  });
});

describe('principalShareOfPayment', () => {
  it('takes principal / tenor off for one full installment', () => {
    // ₦600,000 at 5% over 6 months repays 130,000 a month; 100,000 of it is principal.
    expect(
      principalShareOfPayment(130000, {
        principalAmount: 600000,
        monthlyRatePercent: 5,
        tenorMonths: 6,
      }),
    ).toBeCloseTo(100000, 2);
  });

  it('is proportional for a part payment', () => {
    expect(
      principalShareOfPayment(65000, {
        principalAmount: 600000,
        monthlyRatePercent: 5,
        tenorMonths: 6,
      }),
    ).toBeCloseTo(50000, 2);
  });

  it('is the whole payment at 0% with no charge', () => {
    expect(
      principalShareOfPayment(10000, {
        principalAmount: 120000,
        monthlyRatePercent: 0,
        tenorMonths: 12,
      }),
    ).toBe(10000);
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

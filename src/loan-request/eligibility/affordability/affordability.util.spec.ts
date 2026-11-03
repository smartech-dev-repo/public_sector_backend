import {
  allowedOutcomes,
  DEFAULT_SALARY_PATTERN_OUTCOMES,
  pickSalary,
  resolveOutcomes,
  SALARY_PATTERN_ALIASES,
  SALARY_PATTERNS,
} from './salary-pattern.util';
import { computeMaxLoan, usablePay } from './max-loan.util';

const L = { A: 100000, B: 120000, C: 150000 };
const months = (p: string) =>
  p.split('').map((ch) => L[ch as 'A']) as [number, number, number];

describe('pickSalary', () => {
  // The business's 27-row table (2026-11-03), with ABC, ACB and BCB confirmed as B.
  const table: Record<string, 'A' | 'B' | 'C' | 'AB'> = {
    AAA: 'A',
    ABC: 'B',
    ACB: 'B',
    AAB: 'A',
    AAC: 'A',
    ABB: 'B',
    ABA: 'A',
    ACA: 'A',
    ACC: 'C',
    BBB: 'B',
    BAA: 'A',
    BAB: 'A',
    BAC: 'A',
    BCA: 'A',
    BBA: 'A',
    BBC: 'B',
    BCC: 'C',
    BCB: 'B',
    CCC: 'C',
    CAA: 'A',
    CAC: 'A',
    CBA: 'A',
    CBB: 'B',
    CBC: 'B',
    CAB: 'A',
    CCB: 'B',
    CCA: 'A',
  };

  it.each(Object.entries(table))('%s → %s', (pattern, expected) => {
    expect(pickSalary(months(pattern))!.salary).toBe(L[expected as 'A']);
  });

  it('treats months under ₦1 apart as equal', () => {
    const pick = pickSalary([150000.0, 150000.99, 150000.5])!;
    expect(pick.pattern).toBe('AAA');
    expect(pick.salary).toBe(150000);
  });

  it('treats ₦1 apart as different', () => {
    expect(pickSalary([150000, 150001, 150001])!.pattern).toBe('ABB');
  });

  it('is null when a month is missing or zero', () => {
    expect(pickSalary([100000, null, 100000])).toBeNull();
    expect(pickSalary([100000, 0, 100000])).toBeNull();
  });

  it('averages when the outcome says so', () => {
    const outcomes = {
      ...DEFAULT_SALARY_PATTERN_OUTCOMES,
      ABC: 'AVG_AB' as const,
    };
    expect(pickSalary(months('ABC'), outcomes)!.salary).toBe(110000);
  });

  it('every alias of a pattern picks the same level', () => {
    for (const pattern of SALARY_PATTERNS) {
      for (const alias of SALARY_PATTERN_ALIASES[pattern])
        expect(pickSalary(months(alias))!.pattern).toBe(pattern);
    }
  });
});

describe('outcome rules', () => {
  it('AAA can only be A; two-level patterns cannot use C', () => {
    expect(allowedOutcomes('AAA')).toEqual(['A']);
    expect(allowedOutcomes('ABB')).toEqual(['A', 'B', 'AVG_AB']);
    expect(allowedOutcomes('ABC')).toHaveLength(7);
  });

  it('ignores stored outcomes a pattern cannot use', () => {
    const resolved = resolveOutcomes({
      AAA: 'C',
      ABB: 'AVG_AB',
      ABC: 'nonsense',
    });
    expect(resolved.AAA).toBe('A');
    expect(resolved.ABB).toBe('AVG_AB');
    expect(resolved.ABC).toBe('B');
  });
});

describe('usablePay', () => {
  it('base pay: salary − base pay, never negative', () => {
    expect(
      usablePay(150000, {
        method: 'BASE_PAY',
        basePayAmount: 50000,
        dtiPercent: null,
        source: 'DEFAULT',
      }),
    ).toBe(100000);
    expect(
      usablePay(40000, {
        method: 'BASE_PAY',
        basePayAmount: 50000,
        dtiPercent: null,
        source: 'DEFAULT',
      }),
    ).toBe(0);
  });

  it('DTI: salary × %', () => {
    expect(
      usablePay(150000, {
        method: 'DTI',
        basePayAmount: null,
        dtiPercent: 40,
        source: 'SECTOR',
      }),
    ).toBe(60000);
  });
});

describe('computeMaxLoan', () => {
  const deduct = {
    type: 'PERCENTAGE' as const,
    value: 2,
    application: 'DEDUCT_FROM_DISBURSEMENT' as const,
  };
  const base = {
    tenorMonths: 12,
    monthlyRatePercent: 2,
    charge: deduct,
    productMinimum: 50000,
    productMaximum: 5000000,
  };

  it('usable × tenor / ratio, rounded down to ₦1,000', () => {
    // 100,000 × 12 / 1.24 = 967,741.94
    const result = computeMaxLoan({ ...base, usablePay: 100000 });
    expect(result.paybackRatio).toBeCloseTo(1.24, 10);
    expect(result.maxAmount).toBe(967000);
    expect(result.monthlyRepayment).toBeLessThanOrEqual(100000);
  });

  it('top-up: the loan maximum minus the outstanding balance', () => {
    const result = computeMaxLoan({
      ...base,
      usablePay: 100000,
      outstandingBalance: 400000,
    });
    expect(result.maxAmount).toBe(567000);
    expect(result.newLoanTotal).toBe(967000);
    expect(result.monthlyRepayment).toBeLessThanOrEqual(100000);
  });

  it('top-up: nothing available when the balance already uses the repayment', () => {
    const result = computeMaxLoan({
      ...base,
      usablePay: 100000,
      outstandingBalance: 980000,
    });
    expect(result.maxAmount).toBe(0);
    expect(result.reason).toMatch(/outstanding balance/);
  });

  it('stays within the product maximum, counting the balance', () => {
    expect(
      computeMaxLoan({ ...base, usablePay: 100000, productMaximum: 500000 })
        .maxAmount,
    ).toBe(500000);
    expect(
      computeMaxLoan({
        ...base,
        usablePay: 100000,
        productMaximum: 500000,
        outstandingBalance: 300000,
      }).maxAmount,
    ).toBe(200000);
  });

  it('refuses below the product minimum', () => {
    const result = computeMaxLoan({
      ...base,
      usablePay: 3000,
      productMinimum: 50000,
    });
    expect(result.maxAmount).toBe(0);
    expect(result.reason).toMatch(/product minimum/);
  });

  it('refuses when usable pay is zero', () => {
    expect(computeMaxLoan({ ...base, usablePay: 0 }).reason).toMatch(
      /nothing for a monthly repayment/,
    );
  });

  it('a percentage charge added to repayment lowers the maximum', () => {
    const added = computeMaxLoan({
      ...base,
      usablePay: 100000,
      charge: { type: 'PERCENTAGE', value: 6, application: 'ADD_TO_REPAYMENT' },
    });
    // 1,200,000 / (1.24 + 0.06) = 923,076.92
    expect(added.maxAmount).toBe(923000);
    expect(added.monthlyRepayment).toBeLessThanOrEqual(100000);
  });

  it('a flat charge added to repayment comes off usable pay', () => {
    const added = computeMaxLoan({
      ...base,
      usablePay: 100000,
      charge: { type: 'FLAT', value: 12000, application: 'ADD_TO_REPAYMENT' },
    });
    // (100,000 − 1,000) × 12 / 1.24 = 958,064.52
    expect(added.maxAmount).toBe(958000);
    expect(added.monthlyRepayment).toBeLessThanOrEqual(100000);
  });

  it('a longer tenor allows more', () => {
    const six = computeMaxLoan({
      ...base,
      tenorMonths: 6,
      usablePay: 100000,
    }).maxAmount;
    const twelve = computeMaxLoan({ ...base, usablePay: 100000 }).maxAmount;
    expect(twelve).toBeGreaterThan(six);
  });
});

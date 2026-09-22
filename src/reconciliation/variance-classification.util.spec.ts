import { classifyVariance } from './variance-classification.util';
import { VarianceStatus } from '../generated/prisma/client';

describe('classifyVariance', () => {
  it('returns NO_DEDUCTION_FOUND when actualAmount is 0', () => {
    expect(classifyVariance(0, -5000)).toBe(VarianceStatus.NO_DEDUCTION_FOUND);
  });

  it('returns MATCHED when the variance is within tolerance', () => {
    expect(classifyVariance(45000, 0)).toBe(VarianceStatus.MATCHED);
    expect(classifyVariance(45001, 1)).toBe(VarianceStatus.MATCHED);
  });

  it('returns OVER_PAID when the variance is positive beyond tolerance', () => {
    expect(classifyVariance(50000, 5000)).toBe(VarianceStatus.OVER_PAID);
  });

  it('returns UNDER_PAID when the variance is negative beyond tolerance', () => {
    expect(classifyVariance(30000, -15000)).toBe(VarianceStatus.UNDER_PAID);
  });
});

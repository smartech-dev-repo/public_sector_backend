import { VarianceStatus } from '../generated/prisma/client';

const MATCH_TOLERANCE = 1;

export function classifyVariance(actualAmount: number, variance: number): VarianceStatus {
  if (actualAmount === 0) {
    return VarianceStatus.NO_DEDUCTION_FOUND;
  }
  if (Math.abs(variance) <= MATCH_TOLERANCE) {
    return VarianceStatus.MATCHED;
  }
  return variance > 0 ? VarianceStatus.OVER_PAID : VarianceStatus.UNDER_PAID;
}

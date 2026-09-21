import { VarianceStatus } from '../generated/prisma/client';

export type LoanStatus = 'ACTIVE' | 'DEFAULT' | 'CLOSED';

export function computeLoanStatus(
  loan: { principalBalance: unknown; maturationDate: Date },
  latestVarianceStatus: VarianceStatus | null,
): LoanStatus {
  if (Number(loan.principalBalance) <= 0) {
    return 'CLOSED';
  }

  const pastMaturity = loan.maturationDate.getTime() < Date.now();
  const badVariance =
    latestVarianceStatus === VarianceStatus.UNDER_PAID || latestVarianceStatus === VarianceStatus.NO_DEDUCTION_FOUND;

  if (pastMaturity || badVariance) {
    return 'DEFAULT';
  }

  return 'ACTIVE';
}

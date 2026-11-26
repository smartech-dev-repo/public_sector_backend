import { VarianceStatus } from '../generated/prisma/client';

export type LoanStatus = 'ACTIVE' | 'DEFAULT' | 'CLOSED';

export function computeLoanStatus(
  loan: { principalBalance: unknown; maturationDate: Date; settledAt?: Date | null },
  latestVarianceStatus: VarianceStatus | null,
): LoanStatus {
  // A top-up in the app took over this loan's balance.
  if (loan.settledAt || Number(loan.principalBalance) <= 0) {
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

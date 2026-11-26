import { generatePeriodRange } from '../reconciliation/period.util';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';

export interface ProjectedSchedulePeriod {
  period: string;
  expectedAmount: number;
  actualAmount: null;
  variance: null;
  status: 'UPCOMING';
}

export interface ProjectedLoanRequestSchedule {
  projectedDisbursementDate: Date;
  projectedMaturationDate: Date;
  projectedSchedule: ProjectedSchedulePeriod[];
}

// A LoanRequest that hasn't been disbursed yet has no real disbursement/
// maturation date on file -- project both as if disbursement happened
// today, purely so whoever is viewing it (the client or their agent) can
// see an estimated schedule ahead of approval.
export function projectLoanRequestSchedule(request: {
  amount: number;
  tenorMonths: number;
  interestRatePercent: number;
}): ProjectedLoanRequestSchedule {
  const projectedDisbursementDate = new Date();
  const projectedMaturationDate = new Date(projectedDisbursementDate);
  projectedMaturationDate.setMonth(projectedMaturationDate.getMonth() + request.tenorMonths);

  const expectedAmount = computeExpectedInstallment(
    request.amount,
    request.interestRatePercent,
    projectedDisbursementDate,
    projectedMaturationDate,
  );

  const projectedSchedule = generatePeriodRange(projectedDisbursementDate, projectedMaturationDate).map(
    (period) => ({
      period,
      expectedAmount,
      actualAmount: null,
      variance: null,
      status: 'UPCOMING' as const,
    }),
  );

  return { projectedDisbursementDate, projectedMaturationDate, projectedSchedule };
}

import { PrismaService } from '../prisma/prisma.service';
import { RepaymentResolution } from '../generated/prisma/client';

export interface DeductionTotals {
  /** Every month payroll has been uploaded for. */
  periods: string[];
  /** Loan ID → month → total deducted for that loan in that month. */
  totals: Map<string, Map<string, number>>;
}

/**
 * Deductions per loan and month, from the loan each deduction was matched or assigned to. An
 * assigned deduction counts toward the month it was assigned to. Refunded and dismissed ones count
 * toward nothing.
 */
export async function loadDeductionTotals(
  prisma: PrismaService,
  key: 'loanId' | 'clientLoanId',
): Promise<DeductionTotals> {
  const records = await prisma.loanRepaymentRecord.findMany({
    select: { period: true, appliedPeriod: true, amount: true, loanId: true, clientLoanId: true, resolution: true },
  });
  const periods = new Set<string>();
  const totals = new Map<string, Map<string, number>>();
  for (const record of records) {
    if (record.period) periods.add(record.period);
    const loanId = record[key];
    const period = record.appliedPeriod ?? record.period;
    if (!loanId || !period) continue;
    if (record.resolution === RepaymentResolution.REFUNDED || record.resolution === RepaymentResolution.DISMISSED) continue;
    const byPeriod = totals.get(loanId) ?? new Map<string, number>();
    byPeriod.set(period, round2((byPeriod.get(period) ?? 0) + Number(record.amount)));
    totals.set(loanId, byPeriod);
  }
  return { periods: [...periods], totals };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeExpectedInstallment } from './amortization.util';
import { VarianceStatus } from '../generated/prisma/client';
import { toPeriodKey } from './period.util';

const MATCH_TOLERANCE = 1;

export interface ReconciliationFilters {
  agency?: string;
  status?: VarianceStatus;
  period?: string;
}

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async reconcileAll(): Promise<void> {
    const loans = await this.prisma.loan.findMany();
    const repayments = await this.prisma.loanRepaymentRecord.findMany();

    const periodsSeen = new Set<string>();
    const totalsByLoanKey = new Map<string, Map<string, number>>();

    for (const repayment of repayments) {
      if (!repayment.period) {
        continue;
      }
      periodsSeen.add(repayment.period);
      const loanKey = `${repayment.agency}::${repayment.staffId}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();
      periodMap.set(repayment.period, (periodMap.get(repayment.period) ?? 0) + Number(repayment.amount));
      totalsByLoanKey.set(loanKey, periodMap);
    }

    const allPeriods = Array.from(periodsSeen);

    for (const loan of loans) {
      if (!loan.agency) {
        continue;
      }

      const disbursementPeriod = toPeriodKey(loan.disbursementDate);
      const maturationPeriod = toPeriodKey(loan.maturationDate);
      const applicablePeriods = allPeriods.filter(
        (period) => period >= disbursementPeriod && period <= maturationPeriod,
      );
      if (applicablePeriods.length === 0) {
        continue;
      }

      const expectedAmount = computeExpectedInstallment(
        Number(loan.loanAmount),
        Number(loan.interestRatePercent),
        loan.disbursementDate,
        loan.maturationDate,
      );

      const loanKey = `${loan.agency}::${loan.ippisNumber}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();

      for (const period of applicablePeriods) {
        const actualAmount = periodMap.get(period) ?? 0;
        const variance = actualAmount - expectedAmount;
        const status = this.classify(actualAmount, variance);

        await this.prisma.repaymentVariance.upsert({
          where: { loanId_period: { loanId: loan.id, period } },
          create: { loanId: loan.id, period, expectedAmount, actualAmount, variance, status },
          update: { expectedAmount, actualAmount, variance, status },
        });
      }
    }
  }

  private classify(actualAmount: number, variance: number): VarianceStatus {
    if (actualAmount === 0) {
      return VarianceStatus.NO_DEDUCTION_FOUND;
    }
    if (Math.abs(variance) <= MATCH_TOLERANCE) {
      return VarianceStatus.MATCHED;
    }
    return variance > 0 ? VarianceStatus.OVER_PAID : VarianceStatus.UNDER_PAID;
  }

  async list(filters: ReconciliationFilters) {
    return this.prisma.repaymentVariance.findMany({
      where: {
        status: filters.status,
        period: filters.period,
        loan: filters.agency ? { agency: filters.agency } : undefined,
      },
      include: { loan: true },
      orderBy: { generatedAt: 'desc' },
    });
  }
}

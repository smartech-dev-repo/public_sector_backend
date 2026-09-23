import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeExpectedInstallment } from './amortization.util';
import { VarianceStatus } from '../generated/prisma/client';
import { toPeriodKey } from './period.util';
import { classifyVariance } from './variance-classification.util';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

export interface ReconciliationFilters {
  agency?: string;
  status?: VarianceStatus;
  period?: string;
  generatedFrom?: Date;
  generatedTo?: Date;
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
        const status = classifyVariance(actualAmount, variance);

        await this.prisma.repaymentVariance.upsert({
          where: { loanId_period: { loanId: loan.id, period } },
          create: { loanId: loan.id, period, expectedAmount, actualAmount, variance, status },
          update: { expectedAmount, actualAmount, variance, status },
        });
      }
    }
  }

  async list(
    filters: ReconciliationFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where = {
      status: filters.status,
      period: filters.period,
      loan: filters.agency ? { agency: filters.agency } : undefined,
      generatedAt:
        filters.generatedFrom || filters.generatedTo
          ? { gte: filters.generatedFrom, lte: filters.generatedTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.repaymentVariance.findMany({
        where,
        include: { loan: true },
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.repaymentVariance.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
}

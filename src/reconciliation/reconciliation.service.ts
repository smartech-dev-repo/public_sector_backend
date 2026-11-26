import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeExpectedInstallment } from './amortization.util';
import { VarianceStatus } from '../generated/prisma/client';
import { isWithinLoanPeriod } from './deduction-match.util';
import { loadDeductionTotals } from './deduction-totals.util';
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
    const { periods, totals } = await loadDeductionTotals(this.prisma, 'loanId');

    for (const loan of loans) {
      if (!loan.agency) {
        continue;
      }

      const periodMap = totals.get(loan.id) ?? new Map<string, number>();
      // Every month payroll was uploaded for, plus any month a deduction was assigned to.
      const applicablePeriods = [...new Set([...periods, ...periodMap.keys()])].filter((period) =>
        isWithinLoanPeriod(period, loan),
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

    const [data, total, statusCounts] = await Promise.all([
      this.prisma.repaymentVariance.findMany({
        where,
        include: { loan: true },
        orderBy: { generatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.repaymentVariance.count({ where }),
      this.prisma.repaymentVariance.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);

    // Totals across every matching variance, not just the page being returned.
    const summary = Object.fromEntries(statusCounts.map((row) => [row.status, row._count._all]));

    return { ...buildPaginatedResult(data, total, page, limit), summary };
  }
}

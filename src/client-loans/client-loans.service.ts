import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VarianceStatus } from '../generated/prisma/client';
import { computeLoanStatus, LoanStatus } from './loan-status.util';
import { generatePeriodRange } from '../reconciliation/period.util';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

const LOAN_SELECT = {
  id: true,
  customerId: true,
  customerName: true,
  accountNumber: true,
  address: true,
  branch: true,
  gender: true,
  phone: true,
  ippisNumber: true,
  agency: true,
  loanAmount: true,
  principalBalance: true,
  disbursementDate: true,
  maturationDate: true,
  effectiveDate: true,
  moratoriumDays: true,
  product: true,
  linkedAccountNumber: true,
  bvn: true,
  interestRatePercent: true,
  accountOfficer: true,
  hasPreviouslyTakenLoan: true,
  createdAt: true,
  updatedAt: true,
} as const;

const REPAYMENT_SELECT = {
  id: true,
  agency: true,
  staffId: true,
  period: true,
  elementName: true,
  elementDetail: true,
  amount: true,
  createdAt: true,
} as const;

export interface ListLoansFilters {
  status?: LoanStatus;
  product?: string;
  disbursedFrom?: Date;
  disbursedTo?: Date;
}

@Injectable()
export class ClientLoansService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard(
    clientId: string,
    filters: ListLoansFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { loans: buildPaginatedResult([], 0, pagination.page, pagination.limit), repayments: [] };
    }

    const { agency, staffId } = onboarding.ippisRecord;

    const candidateLoans = await this.prisma.loan.findMany({
      where: {
        agency,
        ippisNumber: staffId,
        product: filters.product,
        disbursementDate:
          filters.disbursedFrom || filters.disbursedTo
            ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
            : undefined,
      },
      select: LOAN_SELECT,
      orderBy: { disbursementDate: 'desc' },
    });

    const matchedLoans = candidateLoans.filter((loan) => this.loanMatchesOnboarding(loan, onboarding));

    const latestVarianceByLoanId = await this.getLatestVarianceStatuses(matchedLoans.map((loan) => loan.id));

    const loansWithStatus = matchedLoans.map((loan) => ({
      ...loan,
      status: computeLoanStatus(loan, latestVarianceByLoanId.get(loan.id) ?? null),
    }));

    const filteredLoans = filters.status
      ? loansWithStatus.filter((loan) => loan.status === filters.status)
      : loansWithStatus;

    const { page, limit } = pagination;
    const pageStart = (page - 1) * limit;
    const pagedLoans = filteredLoans.slice(pageStart, pageStart + limit);

    const repayments = await this.prisma.loanRepaymentRecord.findMany({
      where: { agency, staffId },
      select: REPAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return {
      loans: buildPaginatedResult(pagedLoans, filteredLoans.length, page, limit),
      repayments,
    };
  }

  async getRepaymentPlan(clientId: string, loanId: string) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      throw new NotFoundException('Loan not found');
    }

    const { agency, staffId } = onboarding.ippisRecord;

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, agency, ippisNumber: staffId },
    });
    if (!loan || !this.loanMatchesOnboarding(loan, onboarding)) {
      throw new NotFoundException('Loan not found');
    }

    const periods = generatePeriodRange(loan.disbursementDate, loan.maturationDate);
    const expectedAmount = computeExpectedInstallment(
      Number(loan.loanAmount),
      Number(loan.interestRatePercent),
      loan.disbursementDate,
      loan.maturationDate,
    );

    const varianceRows = await this.prisma.repaymentVariance.findMany({ where: { loanId: loan.id } });
    const varianceByPeriod = new Map(varianceRows.map((row) => [row.period, row]));

    const schedule = periods.map((period) => {
      const varianceRow = varianceByPeriod.get(period);
      if (!varianceRow) {
        return { period, expectedAmount, actualAmount: null, variance: null, status: 'UPCOMING' as const };
      }
      return {
        period,
        expectedAmount,
        actualAmount: Number(varianceRow.actualAmount),
        variance: Number(varianceRow.variance),
        status: varianceRow.status,
      };
    });

    return { loanId: loan.id, schedule };
  }

  private loanMatchesOnboarding(loan: { bvn: string | null }, onboarding: { bvn: string | null }): boolean {
    if (!loan.bvn || !onboarding.bvn) {
      return true;
    }
    return loan.bvn === onboarding.bvn;
  }

  private async getLatestVarianceStatuses(loanIds: string[]): Promise<Map<string, VarianceStatus>> {
    if (loanIds.length === 0) {
      return new Map();
    }

    const rows = await this.prisma.repaymentVariance.findMany({
      where: { loanId: { in: loanIds } },
      orderBy: { period: 'desc' },
      select: { loanId: true, status: true },
    });

    const latest = new Map<string, VarianceStatus>();
    for (const row of rows) {
      if (!latest.has(row.loanId)) {
        latest.set(row.loanId, row.status);
      }
    }
    return latest;
  }
}

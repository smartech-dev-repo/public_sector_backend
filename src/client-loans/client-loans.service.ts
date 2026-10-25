import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientLoan, LoanRequest, LoanRequestStatus, VarianceStatus } from '../generated/prisma/client';
import { computeLoanStatus, LoanStatus } from './loan-status.util';
import { generatePeriodRange } from '../reconciliation/period.util';
import { computeExpectedInstallment } from '../reconciliation/amortization.util';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { projectLoanRequestSchedule } from '../loan-request/projected-schedule.util';

// A client can only ever have one non-terminal LoanRequest at a time (the
// one-lifetime-loan/topup-in-progress policy enforced elsewhere), so this
// never needs its own pagination.
const NON_TERMINAL_LOAN_REQUEST_STATUSES = [
  LoanRequestStatus.PENDING,
  LoanRequestStatus.CONFIRMED,
  LoanRequestStatus.APPROVED,
];

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
    const matched = await this.getMatchedLoansWithStatus(clientId, filters);
    const ingestedLoans = matched ? matched.loans.map((loan) => ({ ...loan, source: 'INGESTED' as const })) : [];
    const appLoans = await this.getFilteredAppLoans(clientId, filters);

    const combinedLoans = [...ingestedLoans, ...appLoans].sort(
      (a, b) => (b.disbursementDate?.getTime() ?? 0) - (a.disbursementDate?.getTime() ?? 0),
    );

    const { page, limit } = pagination;
    const pageStart = (page - 1) * limit;
    const pagedLoans = combinedLoans.slice(pageStart, pageStart + limit);

    const repayments = matched
      ? await this.prisma.loanRepaymentRecord.findMany({
          where: { agency: matched.agency, staffId: matched.staffId },
          select: REPAYMENT_SELECT,
          orderBy: { createdAt: 'desc' },
        })
      : [];

    const pendingRequests = await this.getPendingLoanRequests(clientId);

    return {
      loans: buildPaginatedResult(pagedLoans, combinedLoans.length, page, limit),
      repayments,
      pendingRequests,
    };
  }

  private async getFilteredAppLoans(clientId: string, filters: ListLoansFilters) {
    // App-originated loans have no associated product name to filter by --
    // an explicit product filter can only ever match ingested loans.
    if (filters.product) {
      return [];
    }

    const clientLoans = await this.prisma.clientLoan.findMany({
      where: {
        clientId,
        disbursementDate:
          filters.disbursedFrom || filters.disbursedTo
            ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
            : undefined,
      },
      orderBy: { disbursementDate: 'desc' },
    });

    const filtered = filters.status ? clientLoans.filter((loan) => loan.status === filters.status) : clientLoans;
    return filtered.map((loan) => this.toAppLoanListItem(loan));
  }

  private toAppLoanListItem(loan: ClientLoan) {
    return {
      id: loan.id,
      source: 'APP' as const,
      status: loan.status as LoanStatus,
      customerId: null,
      customerName: null,
      accountNumber: null,
      address: null,
      branch: null,
      gender: null,
      phone: null,
      ippisNumber: loan.staffId,
      agency: loan.agency,
      loanAmount: Number(loan.principalAmount),
      principalBalance: Number(loan.principalBalance),
      disbursementDate: loan.disbursementDate,
      maturationDate: loan.maturationDate,
      effectiveDate: null,
      moratoriumDays: null,
      product: null,
      linkedAccountNumber: null,
      bvn: null,
      interestRatePercent: Number(loan.interestRatePercent),
      accountOfficer: null,
      hasPreviouslyTakenLoan: null,
      createdAt: loan.createdAt,
      updatedAt: loan.updatedAt,
    };
  }

  private async getPendingLoanRequests(clientId: string) {
    const pendingRequests = await this.prisma.loanRequest.findMany({
      where: { clientId, status: { in: NON_TERMINAL_LOAN_REQUEST_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });

    return pendingRequests.map((request) => this.toPendingLoanRequestItem(request));
  }

  private toPendingLoanRequestItem(request: LoanRequest) {
    const principal = Number(request.amount);
    const interestRatePercent = Number(request.interestRatePercent);
    const { projectedDisbursementDate, projectedMaturationDate, projectedSchedule } = projectLoanRequestSchedule({
      amount: principal,
      tenorMonths: request.tenorMonths,
      interestRatePercent,
    });

    return {
      id: request.id,
      type: request.type,
      status: request.status,
      principal,
      tenorMonths: request.tenorMonths,
      interestRatePercent,
      projectedDisbursementDate,
      projectedMaturationDate,
      projectedSchedule,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
    };
  }

  // Unpaginated on purpose — eligibility checks need every matching loan, not one page.
  async hasActiveLoan(clientId: string): Promise<boolean> {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched ? matched.loans.some((loan) => loan.status === 'ACTIVE') : false;
  }

  // Unpaginated on purpose — same reasoning as hasActiveLoan above.
  async hasAnyMatchedLoan(clientId: string): Promise<boolean> {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched ? matched.loans.length > 0 : false;
  }

  async hasOutstandingMatchedLoan(clientId: string): Promise<boolean> {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched ? matched.loans.some((loan) => loan.status !== 'CLOSED') : false;
  }

  // Unpaginated on purpose — same reasoning as hasActiveLoan above.
  async getLatestMatchedLoan(clientId: string) {
    const matched = await this.getMatchedLoansWithStatus(clientId);
    return matched && matched.loans.length > 0 ? matched.loans[0] : null;
  }

  private async getMatchedLoansWithStatus(clientId: string, filters: ListLoansFilters = {}) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return null;
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

    return { agency, staffId, loans: filteredLoans };
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

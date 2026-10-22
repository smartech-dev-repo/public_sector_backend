import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from '../loan-request/loan-request.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { computeExpectedInstallment, monthsBetween } from '../reconciliation/amortization.util';
import { nextPeriodDate } from '../reconciliation/period.util';
import { Client, ClientLoan, IppisRecord } from '../generated/prisma/client';

type MatchedLoan = NonNullable<Awaited<ReturnType<ClientLoansService['getLatestMatchedLoan']>>>;

export interface LoanSummary {
  hasLoan: boolean;
  source: 'APP' | 'INGESTED' | null;
  status: 'ACTIVE' | 'DEFAULT' | 'CLOSED' | null;
  principal: number | null;
  balance: number | null;
  monthlyRepayment: number | null;
  nextPaymentDate: string | null;
  tenorMonths: number | null;
  interestRatePercent: number | null;
}

const NO_LOAN_SUMMARY: LoanSummary = {
  hasLoan: false,
  source: null,
  status: null,
  principal: null,
  balance: null,
  monthlyRepayment: null,
  nextPaymentDate: null,
  tenorMonths: null,
  interestRatePercent: null,
};

@Injectable()
export class ClientLoanSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanRequestService: LoanRequestService,
    private readonly clientLoansService: ClientLoansService,
    private readonly topupEligibilityService: TopupEligibilityService,
  ) {}

  async getSummary(clientId: string): Promise<LoanSummary> {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (clientLoan) {
      return this.buildAppSummary(clientLoan);
    }

    const matched = await this.clientLoansService.getLatestMatchedLoan(clientId);
    if (matched) {
      return this.buildIngestedSummary(matched);
    }

    return NO_LOAN_SUMMARY;
  }

  async getSchedule(clientId: string) {
    const clientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (clientLoan) {
      const loanWithSchedule = await this.loanRequestService.getMyLoan(clientId);
      return loanWithSchedule?.schedule ?? null;
    }

    const matched = await this.clientLoansService.getLatestMatchedLoan(clientId);
    if (!matched) {
      return null;
    }
    const { schedule } = await this.clientLoansService.getRepaymentPlan(clientId, matched.id);
    return schedule;
  }

  async getTopupEligibility(
    client: Client,
    onboarding: { ippisRecord: IppisRecord } | null,
  ): Promise<{ eligible: boolean; reason?: string }> {
    if (!onboarding) {
      return { eligible: false, reason: 'Client has not completed onboarding' };
    }
    return this.topupEligibilityService.check(client, onboarding.ippisRecord, 0);
  }

  private async buildAppSummary(clientLoan: ClientLoan): Promise<LoanSummary> {
    const principal = Number(clientLoan.principalAmount);
    const balance = Number(clientLoan.principalBalance);
    const monthlyRepayment = computeExpectedInstallment(
      principal,
      Number(clientLoan.interestRatePercent),
      clientLoan.disbursementDate,
      clientLoan.maturationDate,
    );

    let nextPaymentDate: string | null = null;
    if (clientLoan.status !== 'CLOSED') {
      const latestVariance = await this.prisma.clientLoanRepaymentVariance.findFirst({
        where: { clientLoanId: clientLoan.id },
        orderBy: { period: 'desc' },
      });
      nextPaymentDate = nextPeriodDate(
        latestVariance?.period ?? null,
        clientLoan.disbursementDate,
        clientLoan.maturationDate,
      );
    }

    return {
      hasLoan: true,
      source: 'APP',
      status: clientLoan.status,
      principal,
      balance,
      monthlyRepayment,
      nextPaymentDate,
      tenorMonths: clientLoan.tenorMonths,
      interestRatePercent: Number(clientLoan.interestRatePercent),
    };
  }

  private async buildIngestedSummary(loan: MatchedLoan): Promise<LoanSummary> {
    const principal = Number(loan.loanAmount);
    const balance = Number(loan.principalBalance);
    const monthlyRepayment = computeExpectedInstallment(
      principal,
      Number(loan.interestRatePercent),
      loan.disbursementDate,
      loan.maturationDate,
    );

    let nextPaymentDate: string | null = null;
    if (loan.status !== 'CLOSED') {
      const latestVariance = await this.prisma.repaymentVariance.findFirst({
        where: { loanId: loan.id },
        orderBy: { period: 'desc' },
      });
      nextPaymentDate = nextPeriodDate(latestVariance?.period ?? null, loan.disbursementDate, loan.maturationDate);
    }

    return {
      hasLoan: true,
      source: 'INGESTED',
      status: loan.status,
      principal,
      balance,
      monthlyRepayment,
      nextPaymentDate,
      tenorMonths: monthsBetween(loan.disbursementDate, loan.maturationDate),
      interestRatePercent: Number(loan.interestRatePercent),
    };
  }
}

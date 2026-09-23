import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, ClientLoanStatus, IppisRecord, LoanRequestStatus } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

const NON_TERMINAL_LOAN_REQUEST_STATUSES = [
  LoanRequestStatus.PENDING,
  LoanRequestStatus.CONFIRMED,
  LoanRequestStatus.APPROVED,
];

@Injectable()
export class NoActiveLoanRule implements EligibilityRule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const inProgressRequest = await this.prisma.loanRequest.findFirst({
      where: { clientId: client.id, status: { in: NON_TERMINAL_LOAN_REQUEST_STATUSES } },
    });
    if (inProgressRequest) {
      return { eligible: false, reason: 'Client already has a loan request in progress' };
    }

    const activeClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id, status: ClientLoanStatus.ACTIVE },
    });
    if (activeClientLoan) {
      return { eligible: false, reason: 'Client already has an active loan' };
    }

    const { loans } = await this.clientLoansService.getDashboard(client.id);
    const hasActiveIngestedLoan = loans.data.some((loan) => loan.status === 'ACTIVE');
    if (hasActiveIngestedLoan) {
      return { eligible: false, reason: 'Client already has an active loan on record' };
    }

    return { eligible: true };
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord, LoanRequestStatus } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { hasLifetimeLoan } from './has-lifetime-loan.util';

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

    if (await hasLifetimeLoan(this.prisma, this.clientLoansService, client.id)) {
      return { eligible: false, reason: 'Client has already taken a loan — only a renewal is available now' };
    }

    return { eligible: true };
  }
}

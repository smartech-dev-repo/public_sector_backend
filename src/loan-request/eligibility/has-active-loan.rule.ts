import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class HasActiveLoanRule implements EligibilityRule {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  /**
   * A top-up renews an existing loan, and can happen at any time: the balance still owed
   * carries into the renewed loan, and the salary check decides how much extra is allowed.
   * Only a client with no loan at all is refused (they take a new loan instead).
   */
  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const appLoan = await this.prisma.clientLoan.findFirst({ where: { clientId: client.id }, select: { id: true } });
    if (appLoan) return { eligible: true };
    if (await this.clientLoansService.hasAnyMatchedLoan(client.id)) return { eligible: true };
    return { eligible: false, reason: 'Client has no existing loan to renew' };
  }
}

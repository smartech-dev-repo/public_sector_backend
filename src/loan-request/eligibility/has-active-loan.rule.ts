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

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const latestClientLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id },
      orderBy: { disbursementDate: 'desc' },
    });

    if (latestClientLoan) {
      if (Number(latestClientLoan.principalBalance) > 0) {
        return { eligible: false, reason: 'Existing loan still has an outstanding balance' };
      }
      return { eligible: true };
    }

    if (await this.clientLoansService.hasOutstandingMatchedLoan(client.id)) {
      return { eligible: false, reason: 'Existing loan still has an outstanding balance' };
    }
    if (!(await this.clientLoansService.hasAnyMatchedLoan(client.id))) {
      return { eligible: false, reason: 'Client has no existing loan to renew' };
    }

    return { eligible: true };
  }
}

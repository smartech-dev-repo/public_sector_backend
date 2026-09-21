import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Client, ClientLoanStatus, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class HasActiveLoanRule implements EligibilityRule {
  constructor(private readonly prisma: PrismaService) {}

  async check(client: Client, _ippisRecord: IppisRecord, _amount: number): Promise<EligibilityCheckResult> {
    const activeLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId: client.id, status: ClientLoanStatus.ACTIVE },
    });
    if (!activeLoan) {
      return { eligible: false, reason: 'Client has no active loan to top up' };
    }
    return { eligible: true };
  }
}

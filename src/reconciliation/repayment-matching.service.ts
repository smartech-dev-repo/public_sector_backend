import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestStatus } from '../generated/prisma/client';
import { DeductionMatchContext, staffKey } from './deduction-match.util';

@Injectable()
export class RepaymentMatchingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RepaymentMatchingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Deductions stored before matching existed, or since a loan was disbursed, get their match on start. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.rematchAll();
    } catch (error) {
      this.logger.error(`Could not match repayment deductions: ${error instanceof Error ? error.message : error}`);
    }
  }

  async buildContext(): Promise<DeductionMatchContext> {
    const [clientLoans, loans, requests] = await Promise.all([
      this.prisma.clientLoan.findMany({
        select: { id: true, agency: true, staffId: true, disbursementDate: true, maturationDate: true },
      }),
      this.prisma.loan.findMany({
        select: { id: true, agency: true, ippisNumber: true, disbursementDate: true, maturationDate: true, settledAt: true },
      }),
      this.prisma.loanRequest.findMany({
        where: { status: { not: LoanRequestStatus.DISBURSED } },
        select: { client: { select: { onboarding: { select: { ippisRecord: { select: { agency: true, staffId: true } } } } } } },
      }),
    ]);
    const requested = requests.flatMap((request) => {
      const record = request.client.onboarding?.ippisRecord;
      return record ? [staffKey(record.agency, record.staffId)] : [];
    });
    return new DeductionMatchContext(clientLoans, loans, requested);
  }

  /**
   * Matches every deduction an admin hasn't resolved to the loan running in its month. Resolved
   * ones keep what the admin chose. Returns how many changed.
   */
  async rematchAll(): Promise<number> {
    const [context, records] = await Promise.all([
      this.buildContext(),
      this.prisma.loanRepaymentRecord.findMany({
        where: { resolution: null },
        select: { id: true, agency: true, staffId: true, period: true, matchStatus: true, loanId: true, clientLoanId: true },
      }),
    ]);
    let changed = 0;
    for (const record of records) {
      const match = context.match(record);
      if (match.status === record.matchStatus && match.loanId === record.loanId && match.clientLoanId === record.clientLoanId) {
        continue;
      }
      await this.prisma.loanRepaymentRecord.update({
        where: { id: record.id },
        data: { matchStatus: match.status, loanId: match.loanId, clientLoanId: match.clientLoanId },
      });
      changed++;
    }
    return changed;
  }
}

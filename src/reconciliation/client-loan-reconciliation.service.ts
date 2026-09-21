import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { computeExpectedInstallment } from './amortization.util';
import { toPeriodKey } from './period.util';
import { computeClientLoanStatus } from './client-loan-status.util';
import { AuditActorType, VarianceStatus } from '../generated/prisma/client';

const MATCH_TOLERANCE = 1;

@Injectable()
export class ClientLoanReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  async reconcileAll(): Promise<void> {
    const clientLoans = await this.prisma.clientLoan.findMany();
    const repayments = await this.prisma.loanRepaymentRecord.findMany();

    const periodsSeen = new Set<string>();
    const totalsByLoanKey = new Map<string, Map<string, number>>();

    for (const repayment of repayments) {
      if (!repayment.period) {
        continue;
      }
      periodsSeen.add(repayment.period);
      const loanKey = `${repayment.agency}::${repayment.staffId}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();
      periodMap.set(repayment.period, (periodMap.get(repayment.period) ?? 0) + Number(repayment.amount));
      totalsByLoanKey.set(loanKey, periodMap);
    }

    const allPeriods = Array.from(periodsSeen);

    for (const clientLoan of clientLoans) {
      const disbursementPeriod = toPeriodKey(clientLoan.disbursementDate);
      const maturationPeriod = toPeriodKey(clientLoan.maturationDate);
      const applicablePeriods = allPeriods
        .filter((period) => period >= disbursementPeriod && period <= maturationPeriod)
        .sort();
      if (applicablePeriods.length === 0) {
        continue;
      }

      const loanKey = `${clientLoan.agency}::${clientLoan.staffId}`;
      const periodMap = totalsByLoanKey.get(loanKey) ?? new Map<string, number>();

      const expectedAmount = computeExpectedInstallment(
        Number(clientLoan.principalAmount),
        Number(clientLoan.interestRatePercent),
        clientLoan.disbursementDate,
        clientLoan.maturationDate,
      );

      let updatedBalance = Number(clientLoan.principalBalance);
      let processedAnyPeriod = false;

      for (const period of applicablePeriods) {
        const existing = await this.prisma.clientLoanRepaymentVariance.findUnique({
          where: { clientLoanId_period: { clientLoanId: clientLoan.id, period } },
        });
        if (existing) {
          continue;
        }

        const actualAmount = periodMap.get(period) ?? 0;
        const variance = actualAmount - expectedAmount;
        const status = this.classify(actualAmount, variance);

        await this.prisma.clientLoanRepaymentVariance.create({
          data: { clientLoanId: clientLoan.id, period, expectedAmount, actualAmount, variance, status },
        });

        updatedBalance -= Math.min(actualAmount, expectedAmount);
        processedAnyPeriod = true;

        if (actualAmount > expectedAmount) {
          await this.walletService.credit(
            clientLoan.clientId,
            actualAmount - expectedAmount,
            `Loan overpayment excess — ${clientLoan.agency} ${period}`,
            { actorType: AuditActorType.SYSTEM },
          );
        }
      }

      if (processedAnyPeriod) {
        const latestVariance = await this.prisma.clientLoanRepaymentVariance.findFirst({
          where: { clientLoanId: clientLoan.id },
          orderBy: { period: 'desc' },
        });
        const newStatus = computeClientLoanStatus(
          { principalBalance: updatedBalance, maturationDate: clientLoan.maturationDate },
          latestVariance?.status ?? null,
        );

        await this.prisma.clientLoan.update({
          where: { id: clientLoan.id },
          data: { principalBalance: updatedBalance, status: newStatus },
        });
      }
    }
  }

  private classify(actualAmount: number, variance: number): VarianceStatus {
    if (actualAmount === 0) {
      return VarianceStatus.NO_DEDUCTION_FOUND;
    }
    if (Math.abs(variance) <= MATCH_TOLERANCE) {
      return VarianceStatus.MATCHED;
    }
    return variance > 0 ? VarianceStatus.OVER_PAID : VarianceStatus.UNDER_PAID;
  }
}

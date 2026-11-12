import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { clientLoanInstallment, clientLoanPrincipalPaid } from './client-loan-terms.util';
import { computeClientLoanStatus } from './client-loan-status.util';
import { AuditActorType, VarianceSource, WalletEntrySource } from '../generated/prisma/client';
import { classifyVariance } from './variance-classification.util';
import { isWithinLoanPeriod } from './deduction-match.util';
import { loadDeductionTotals } from './deduction-totals.util';

@Injectable()
export class ClientLoanReconciliationService {
  private readonly logger = new Logger(ClientLoanReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Applies each month's deductions to the app loan they were matched or assigned to. A month
   * already applied is applied again only by the difference, when its deductions have changed
   * since: a deduction assigned to it later, or a corrected upload.
   */
  async reconcileAll(): Promise<void> {
    const clientLoans = await this.prisma.clientLoan.findMany({ include: { repaymentVariances: true } });
    const { periods, totals } = await loadDeductionTotals(this.prisma, 'clientLoanId');

    for (const clientLoan of clientLoans) {
      const periodMap = totals.get(clientLoan.id) ?? new Map<string, number>();
      const applicablePeriods = [...new Set([...periods, ...periodMap.keys()])]
        .filter((period) => isWithinLoanPeriod(period, clientLoan))
        .sort();
      if (applicablePeriods.length === 0) {
        continue;
      }

      const existingByPeriod = new Map(clientLoan.repaymentVariances.map((v) => [v.period, v]));
      const installment = clientLoanInstallment(clientLoan);

      let updatedBalance = Number(clientLoan.principalBalance);
      let processedAnyPeriod = false;

      for (const period of applicablePeriods) {
        const existing = existingByPeriod.get(period);
        const actualAmount = periodMap.get(period) ?? 0;
        const previousAmount = existing ? Number(existing.actualAmount) : 0;
        // A month the client paid from their wallet keeps that payment; payroll doesn't overwrite it.
        if (existing && (existing.source === VarianceSource.WALLET_APPLICATION || Math.abs(actualAmount - previousAmount) < 0.005)) {
          continue;
        }

        const expectedAmount = existing ? Number(existing.expectedAmount) : installment;
        const variance = actualAmount - expectedAmount;
        const status = classifyVariance(actualAmount, variance);

        if (existing) {
          await this.prisma.clientLoanRepaymentVariance.update({
            where: { id: existing.id },
            data: { actualAmount, variance, status },
          });
        } else {
          await this.prisma.clientLoanRepaymentVariance.create({
            data: { clientLoanId: clientLoan.id, period, expectedAmount, actualAmount, variance, status },
          });
        }

        // The installment is principal plus interest; only the principal share reduces the balance.
        updatedBalance -=
          clientLoanPrincipalPaid(clientLoan, Math.min(actualAmount, expectedAmount)) -
          clientLoanPrincipalPaid(clientLoan, Math.min(previousAmount, expectedAmount));
        processedAnyPeriod = true;

        const excess = Math.max(0, actualAmount - expectedAmount) - Math.max(0, previousAmount - expectedAmount);
        if (excess > 0) {
          await this.walletService.credit(
            clientLoan.clientId,
            Math.round(excess * 100) / 100,
            `Loan overpayment excess — ${clientLoan.agency} ${period}`,
            { actorType: AuditActorType.SYSTEM },
            { source: WalletEntrySource.LOAN_OVERPAYMENT, reference: clientLoan.id },
          );
        } else if (excess < 0) {
          // An excess already credited to the wallet isn't taken back automatically.
          this.logger.warn(`Client loan ${clientLoan.id} ${period}: deductions fell below an excess already credited`);
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
          data: { principalBalance: Math.max(0, Math.round(updatedBalance * 100) / 100), status: newStatus },
        });
      }
    }
  }
}

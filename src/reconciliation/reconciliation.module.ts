import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { ClientLoanReconciliationService } from './client-loan-reconciliation.service';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { AdminDeductionsController } from './admin-deductions.controller';
import { RepaymentMatchingService } from './repayment-matching.service';
import { DeductionResolutionService } from './deduction-resolution.service';
import { WalletModule } from '../wallet/wallet.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [WalletModule, ApprovalsModule, AuditModule],
  controllers: [AdminReconciliationController, AdminDeductionsController],
  providers: [ReconciliationService, ClientLoanReconciliationService, RepaymentMatchingService, DeductionResolutionService],
  exports: [ReconciliationService, ClientLoanReconciliationService, RepaymentMatchingService],
})
export class ReconciliationModule {}

import { Module } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { ClientLoanReconciliationService } from './client-loan-reconciliation.service';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [WalletModule],
  controllers: [AdminReconciliationController],
  providers: [ReconciliationService, ClientLoanReconciliationService],
  exports: [ReconciliationService, ClientLoanReconciliationService],
})
export class ReconciliationModule {}

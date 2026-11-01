import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { AuditModule } from '../audit/audit.module';
import { WalletService } from './wallet.service';
import { ClientWalletController } from './client-wallet.controller';
import { AdminWalletController } from './admin-wallet.controller';

@Module({
  imports: [AuditModule, ApprovalsModule],
  controllers: [ClientWalletController, AdminWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { WalletService } from './wallet.service';
import { ClientWalletController } from './client-wallet.controller';
import { AdminWalletController } from './admin-wallet.controller';

@Module({
  imports: [AuditModule],
  controllers: [ClientWalletController, AdminWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}

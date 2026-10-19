import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { ClientProfileController } from './client-profile.controller';
import { ClientProfileService } from './client-profile.service';

@Module({
  imports: [WalletModule, ClientLoansModule],
  controllers: [ClientProfileController],
  providers: [ClientProfileService],
})
export class ClientProfileModule {}

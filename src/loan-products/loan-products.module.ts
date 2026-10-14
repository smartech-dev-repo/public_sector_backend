import { Module } from '@nestjs/common';
import { LoanProductsService } from './loan-products.service';
import { AdminLoanProductsController } from './admin-loan-products.controller';
import { ClientLoanProductsController } from './client-loan-products.controller';
import { LoanSettingsModule } from '../loan-settings/loan-settings.module';

@Module({
  imports: [LoanSettingsModule],
  controllers: [AdminLoanProductsController, ClientLoanProductsController],
  providers: [LoanProductsService],
  exports: [LoanProductsService],
})
export class LoanProductsModule {}

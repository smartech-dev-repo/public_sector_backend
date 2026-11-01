import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LoanProductsService } from './loan-products.service';
import { AdminLoanProductsController } from './admin-loan-products.controller';
import { ClientLoanProductsController } from './client-loan-products.controller';
import { AgentLoanProductsController } from './agent-loan-products.controller';
import { LoanSettingsModule } from '../loan-settings/loan-settings.module';
import { LoanRequestModule } from '../loan-request/loan-request.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { ManagementFeesModule } from '../management-fees/management-fees.module';

@Module({
  imports: [AuditModule, LoanSettingsModule, LoanRequestModule, ClientLoansModule, ManagementFeesModule],
  controllers: [AdminLoanProductsController, ClientLoanProductsController, AgentLoanProductsController],
  providers: [LoanProductsService],
  exports: [LoanProductsService],
})
export class LoanProductsModule {}

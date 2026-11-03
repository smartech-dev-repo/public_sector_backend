import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LoanSettingsService } from './loan-settings.service';
import { AdminLoanSettingsController } from './admin-loan-settings.controller';
import { AdminRepaymentCapacityController } from './admin-repayment-capacity.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminLoanSettingsController, AdminRepaymentCapacityController],
  providers: [LoanSettingsService],
  exports: [LoanSettingsService],
})
export class LoanSettingsModule {}

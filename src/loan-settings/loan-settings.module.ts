import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LoanSettingsService } from './loan-settings.service';
import { AdminLoanSettingsController } from './admin-loan-settings.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminLoanSettingsController],
  providers: [LoanSettingsService],
  exports: [LoanSettingsService],
})
export class LoanSettingsModule {}

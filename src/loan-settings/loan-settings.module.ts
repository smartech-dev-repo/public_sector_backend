import { Module } from '@nestjs/common';
import { LoanSettingsService } from './loan-settings.service';
import { AdminLoanSettingsController } from './admin-loan-settings.controller';

@Module({
  controllers: [AdminLoanSettingsController],
  providers: [LoanSettingsService],
  exports: [LoanSettingsService],
})
export class LoanSettingsModule {}

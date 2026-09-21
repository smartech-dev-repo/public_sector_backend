import { Module } from '@nestjs/common';
import { LoanTermOptionService } from './loan-terms.service';
import { AdminLoanTermsController } from './admin-loan-terms.controller';
import { ClientLoanTermsController } from './client-loan-terms.controller';

@Module({
  controllers: [AdminLoanTermsController, ClientLoanTermsController],
  providers: [LoanTermOptionService],
  exports: [LoanTermOptionService],
})
export class LoanTermsModule {}

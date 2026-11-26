import { Module } from '@nestjs/common';
import { LoanRequestModule } from '../loan-request/loan-request.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { ClientLoanSummaryService } from './client-loan-summary.service';

@Module({
  imports: [LoanRequestModule, ClientLoansModule],
  providers: [ClientLoanSummaryService],
  exports: [ClientLoanSummaryService],
})
export class ClientLoanSummaryModule {}

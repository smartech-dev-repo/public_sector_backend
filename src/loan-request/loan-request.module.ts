import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoanRequestController } from './loan-request.controller';
import { SmsWebhookController } from './sms-webhook.controller';
import { LoanRequestService } from './loan-request.service';
import { LoanRequestExpiryProcessor } from './loan-request-expiry.processor';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { EligibilityService } from './eligibility/eligibility.service';
import { ClientMustBeVerifiedRule } from './eligibility/client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './eligibility/amount-within-salary-cap.rule';
import { NoActiveLoanRule } from './eligibility/no-active-loan.rule';
import { TwoWaySmsModule } from '../two-way-sms/two-way-sms.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: LOAN_REQUEST_EXPIRY_QUEUE }),
    TwoWaySmsModule,
    ClientLoansModule,
  ],
  controllers: [LoanRequestController, SmsWebhookController],
  providers: [
    LoanRequestService,
    LoanRequestExpiryProcessor,
    EligibilityService,
    ClientMustBeVerifiedRule,
    AmountWithinSalaryCapRule,
    NoActiveLoanRule,
  ],
})
export class LoanRequestModule {}

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LoanRequestController } from './loan-request.controller';
import { AgentLoanRequestController } from './agent-loan-request.controller';
import { SmsWebhookController } from './sms-webhook.controller';
import { AdminLoanRequestController } from './admin-loan-request.controller';
import { AdminClientLoansController } from './admin-client-loans.controller';
import { ClientLoanController } from './client-loan.controller';
import { LoanRequestService } from './loan-request.service';
import { LoanRequestExpiryProcessor } from './loan-request-expiry.processor';
import { LOAN_REQUEST_EXPIRY_QUEUE } from './loan-request-queue.constants';
import { EligibilityService } from './eligibility/eligibility.service';
import { ClientMustBeVerifiedRule } from './eligibility/client-must-be-verified.rule';
import { NoActiveLoanRule } from './eligibility/no-active-loan.rule';
import { HasActiveLoanRule } from './eligibility/has-active-loan.rule';
import { NoTopupInProgressRule } from './eligibility/no-topup-in-progress.rule';
import { TopupEligibilityService } from './eligibility/topup-eligibility.service';
import { LoanProductResolverService } from './eligibility/loan-product-resolver.service';
import { TwoWaySmsModule } from '../two-way-sms/two-way-sms.module';
import { ClientLoansModule } from '../client-loans/client-loans.module';
import { AuditModule } from '../audit/audit.module';
import { WalletModule } from '../wallet/wallet.module';
import { EmailModule } from '../email/email.module';
import { LoanSettingsModule } from '../loan-settings/loan-settings.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: LOAN_REQUEST_EXPIRY_QUEUE }),
    TwoWaySmsModule,
    ClientLoansModule,
    AuditModule,
    WalletModule,
    EmailModule,
    LoanSettingsModule,
  ],
  controllers: [
    LoanRequestController,
    AgentLoanRequestController,
    SmsWebhookController,
    AdminLoanRequestController,
    AdminClientLoansController,
    ClientLoanController,
  ],
  providers: [
    LoanRequestService,
    LoanRequestExpiryProcessor,
    EligibilityService,
    ClientMustBeVerifiedRule,
    NoActiveLoanRule,
    HasActiveLoanRule,
    NoTopupInProgressRule,
    TopupEligibilityService,
    LoanProductResolverService,
  ],
  exports: [EligibilityService, TopupEligibilityService],
})
export class LoanRequestModule {}

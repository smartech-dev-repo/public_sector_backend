import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminClientReviewService } from './admin-client-review.service';
import { AdminClientActivityService } from './admin-client-activity.service';
import { AdminClientAnalyticsService } from './admin-client-analytics.service';
import { AdminClientReviewController } from './admin-client-review.controller';
import { ClientOnboardingModule } from '../client-onboarding/client-onboarding.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { ClientLoanSummaryModule } from '../client-loan-summary/client-loan-summary.module';

@Module({
  imports: [AuditModule, ClientOnboardingModule, FileStorageModule, ClientLoanSummaryModule],
  controllers: [AdminClientReviewController],
  providers: [AdminClientReviewService, AdminClientActivityService, AdminClientAnalyticsService],
})
export class AdminClientReviewModule {}

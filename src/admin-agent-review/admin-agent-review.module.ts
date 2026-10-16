import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { AdminAgentReviewController } from './admin-agent-review.controller';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';

@Module({
  imports: [AuditModule, EmailModule],
  controllers: [AdminAgentReviewController],
  providers: [AdminAgentReviewService, AdminAgentAnalyticsService],
})
export class AdminAgentReviewModule {}

import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminClientReviewService } from './admin-client-review.service';
import { AdminClientReviewController } from './admin-client-review.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminClientReviewController],
  providers: [AdminClientReviewService],
})
export class AdminClientReviewModule {}

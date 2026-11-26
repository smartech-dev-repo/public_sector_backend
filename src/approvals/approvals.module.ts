import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminApprovalsController } from './admin-approvals.controller';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [AuditModule, NotificationsModule],
  controllers: [AdminApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}

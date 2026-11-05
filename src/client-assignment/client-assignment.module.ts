import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ClientAssignmentService } from './client-assignment.service';
import {
  AdminClientAssignmentController,
  AgentClientLinkController,
} from './client-assignment.controllers';

@Module({
  imports: [AuditModule, SmsModule, NotificationsModule],
  controllers: [AdminClientAssignmentController, AgentClientLinkController],
  providers: [ClientAssignmentService],
  exports: [ClientAssignmentService],
})
export class ClientAssignmentModule {}

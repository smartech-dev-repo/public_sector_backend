import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminAlertRecipientsController } from './admin-alert-recipients.controller';
import { AlertRecipientsService } from './alert-recipients.service';

@Module({
  imports: [AuditModule],
  controllers: [AdminAlertRecipientsController],
  providers: [AlertRecipientsService],
})
export class AlertRecipientsModule {}

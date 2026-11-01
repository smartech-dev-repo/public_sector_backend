import { Module } from '@nestjs/common';
import { AdminNotificationsController } from './admin-notifications.controller';
import { NotificationService } from './notification.service';

@Module({
  controllers: [AdminNotificationsController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationsModule {}

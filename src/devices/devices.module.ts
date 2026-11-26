import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { SmsModule } from '../sms/sms.module';
import { SessionModule } from '../session/session.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { DeviceBindingService } from './device-binding.service';
import { DeviceReleaseService } from './device-release.service';
import { AdminDevicesController } from './admin-devices.controller';
import {
  AgentDeviceController,
  ClientDeviceController,
  DeviceReleaseRequestController,
} from './device-self.controllers';

@Global()
@Module({
  imports: [
    JwtModule.register({}),
    AuditModule,
    EmailModule,
    SmsModule,
    SessionModule,
    NotificationsModule,
    FileStorageModule,
  ],
  controllers: [
    DeviceReleaseRequestController,
    AgentDeviceController,
    ClientDeviceController,
    AdminDevicesController,
  ],
  providers: [DeviceBindingService, DeviceReleaseService],
  exports: [DeviceBindingService],
})
export class DevicesModule {}

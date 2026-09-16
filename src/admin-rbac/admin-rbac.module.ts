import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionService } from './permission.service';
import { AdminPermissionsController } from './admin-permissions.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminPermissionsController],
  providers: [PermissionService],
})
export class AdminRbacModule {}

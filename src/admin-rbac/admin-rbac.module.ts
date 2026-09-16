import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PermissionService } from './permission.service';
import { RoleService } from './role.service';
import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminRolesController } from './admin-roles.controller';

@Module({
  imports: [AuditModule],
  controllers: [AdminPermissionsController, AdminRolesController],
  providers: [PermissionService, RoleService],
})
export class AdminRbacModule {}

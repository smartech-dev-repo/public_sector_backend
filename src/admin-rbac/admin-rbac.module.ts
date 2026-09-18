import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SessionModule } from '../session/session.module';
import { PermissionService } from './permission.service';
import { RoleService } from './role.service';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { AdminPermissionsController } from './admin-permissions.controller';
import { AdminRolesController } from './admin-roles.controller';
import { AdminRoleAssignmentController } from './admin-role-assignment.controller';

@Module({
  imports: [AuditModule, SessionModule],
  controllers: [AdminPermissionsController, AdminRolesController, AdminRoleAssignmentController],
  providers: [PermissionService, RoleService, AdminRoleAssignmentService],
})
export class AdminRbacModule {}

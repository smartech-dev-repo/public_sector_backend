import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { AssignRoleDto } from './dto/assign-role.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/admins')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminRoleAssignmentController {
  constructor(
    private readonly adminRoleAssignmentService: AdminRoleAssignmentService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('roles:manage')
  list() {
    return this.adminRoleAssignmentService.listAdmins();
  }

  @Post(':id/roles')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async assignRole(
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.adminRoleAssignmentService.assignRole(id, dto.roleId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.role.assigned',
      targetType: 'AdminUser',
      targetId: id,
      metadata: { roleId: dto.roleId },
    });
    return { assigned: true };
  }

  @Delete(':id/roles/:roleId')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async removeRole(
    @Param('id') id: string,
    @Param('roleId') roleId: string,
    @Req() req: { user: JwtPayload },
  ) {
    await this.adminRoleAssignmentService.removeRole(id, roleId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.role.removed',
      targetType: 'AdminUser',
      targetId: id,
      metadata: { roleId },
    });
    return { removed: true };
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async deactivate(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.deactivate(req.user.sub, id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.deactivated',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { deactivated: true };
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async reactivate(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.reactivate(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.reactivated',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { reactivated: true };
  }
}

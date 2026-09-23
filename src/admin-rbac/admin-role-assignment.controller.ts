import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { AssignRoleDto } from './dto/assign-role.dto';
import { ListAdminsQueryDto } from './dto/list-admins-query.dto';
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
  list(@Query() query: ListAdminsQueryDto) {
    return this.adminRoleAssignmentService.listAdmins(
      {
        isActive: query.isActive,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Patch(':id/role')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async setRole(
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.adminRoleAssignmentService.setRole(id, dto.roleId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.role.set',
      targetType: 'AdminUser',
      targetId: id,
      metadata: { roleId: dto.roleId },
    });
    return { updated: true };
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async suspend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.suspend(req.user.sub, id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.suspended',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { suspended: true };
  }

  @Post(':id/unsuspend')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async unsuspend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminRoleAssignmentService.unsuspend(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.unsuspended',
      targetType: 'AdminUser',
      targetId: id,
    });
    return { unsuspended: true };
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { RoleService } from './role.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionDto } from './dto/assign-permission.dto';
import { AssignPermissionsBulkDto } from './dto/assign-permissions-bulk.dto';
import { ListRolesQueryDto } from './dto/list-roles-query.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/roles')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminRolesController {
  constructor(
    private readonly roleService: RoleService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('roles:manage')
  async create(@Body() dto: CreateRoleDto, @Req() req: { user: JwtPayload }) {
    const role = await this.roleService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.created',
      targetType: 'Role',
      targetId: role.id,
      metadata: { name: role.name },
    });
    return role;
  }

  @Get()
  @RequirePermissions('roles:manage')
  list(@Query() query: ListRolesQueryDto) {
    return this.roleService.list({ q: query.q }, { page: query.page, limit: query.limit });
  }

  @Get(':id')
  @RequirePermissions('roles:manage')
  findOne(@Param('id') id: string) {
    return this.roleService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('roles:manage')
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
    return this.roleService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.roleService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.deleted',
      targetType: 'Role',
      targetId: id,
    });
    return { deleted: true };
  }

  @Post(':id/permissions')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async assignPermission(
    @Param('id') id: string,
    @Body() dto: AssignPermissionDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.roleService.assignPermission(id, dto.permissionId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.permission.assigned',
      targetType: 'Role',
      targetId: id,
      metadata: { permissionId: dto.permissionId },
    });
    return { assigned: true };
  }

  @Post(':id/permissions/bulk')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async assignPermissionsBulk(
    @Param('id') id: string,
    @Body() dto: AssignPermissionsBulkDto,
    @Req() req: { user: JwtPayload },
  ) {
    await this.roleService.assignPermissions(id, dto.permissionIds);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.permissions.bulk_assigned',
      targetType: 'Role',
      targetId: id,
      metadata: { permissionIds: dto.permissionIds },
    });
    return { assigned: true };
  }

  @Delete(':id/permissions/:permissionId')
  @HttpCode(200)
  @RequirePermissions('roles:manage')
  async removePermission(
    @Param('id') id: string,
    @Param('permissionId') permissionId: string,
    @Req() req: { user: JwtPayload },
  ) {
    await this.roleService.removePermission(id, permissionId);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'role.permission.removed',
      targetType: 'Role',
      targetId: id,
      metadata: { permissionId },
    });
    return { removed: true };
  }
}

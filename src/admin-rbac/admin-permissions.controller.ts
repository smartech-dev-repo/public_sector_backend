import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { PermissionService } from './permission.service';
import { CreatePermissionDto } from './dto/create-permission.dto';
import { UpdatePermissionDto } from './dto/update-permission.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminPermissionsController {
  constructor(
    private readonly permissionService: PermissionService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('permissions:manage')
  async create(@Body() dto: CreatePermissionDto, @Req() req: { user: JwtPayload }) {
    const permission = await this.permissionService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'permission.created',
      targetType: 'Permission',
      targetId: permission.id,
      metadata: { key: permission.key },
    });
    return permission;
  }

  @Get()
  @RequirePermissions('permissions:manage')
  list() {
    return this.permissionService.list();
  }

  @Get(':id')
  @RequirePermissions('permissions:manage')
  findOne(@Param('id') id: string) {
    return this.permissionService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('permissions:manage')
  update(@Param('id') id: string, @Body() dto: UpdatePermissionDto) {
    return this.permissionService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('permissions:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.permissionService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'permission.deleted',
      targetType: 'Permission',
      targetId: id,
    });
    return { deleted: true };
  }
}

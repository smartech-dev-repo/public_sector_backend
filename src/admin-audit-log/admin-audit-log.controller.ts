import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @RequirePermissions('audit:read')
  list(
    @Query('actorType') actorType?: AuditActorType,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.auditLogService.list({ actorType, action, targetType, targetId });
  }
}

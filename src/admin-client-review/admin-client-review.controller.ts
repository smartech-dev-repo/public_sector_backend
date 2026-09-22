import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminClientReviewService } from './admin-client-review.service';
import { AdminClientActivityService } from './admin-client-activity.service';
import { RetryReviewDto } from './dto/retry-review.dto';
import { AuditActorType, ClientStatus } from '../generated/prisma/client';

@Controller('admin/clients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminClientReviewController {
  constructor(
    private readonly adminClientReviewService: AdminClientReviewService,
    private readonly auditLogService: AuditLogService,
    private readonly adminClientActivityService: AdminClientActivityService,
  ) {}

  @Get()
  @RequirePermissions('clients:review')
  list(@Query('status') status?: ClientStatus) {
    return this.adminClientReviewService.list(status);
  }

  @Get(':id')
  @RequirePermissions('clients:review')
  findOne(@Param('id') id: string) {
    return this.adminClientReviewService.findById(id);
  }

  @Get(':id/activities')
  @RequirePermissions('clients:read')
  getActivities(@Param('id') id: string) {
    return this.adminClientActivityService.listActivities(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('clients:review')
  async approve(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const client = await this.adminClientReviewService.approve(id, req.user.sub);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'client.review.approved',
      targetType: 'Client',
      targetId: id,
    });
    return client;
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermissions('clients:review')
  async retry(@Param('id') id: string, @Body() dto: RetryReviewDto, @Req() req: { user: JwtPayload }) {
    const client = await this.adminClientReviewService.retry(id, req.user.sub, dto.note);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'client.review.retried',
      targetType: 'Client',
      targetId: id,
      metadata: { note: dto.note },
    });
    return client;
  }
}

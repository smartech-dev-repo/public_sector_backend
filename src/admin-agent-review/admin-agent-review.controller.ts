import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { RejectAgentDto } from './dto/reject-agent.dto';
import { AgentStatus, AuditActorType } from '../generated/prisma/client';

@Controller('admin/agents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminAgentReviewController {
  constructor(
    private readonly adminAgentReviewService: AdminAgentReviewService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @RequirePermissions('agents:read')
  list(@Query('status') status?: AgentStatus) {
    return this.adminAgentReviewService.list(status);
  }

  @Get(':id')
  @RequirePermissions('agents:read')
  findById(@Param('id') id: string) {
    return this.adminAgentReviewService.findById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('agents:review')
  async approve(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminAgentReviewService.approve(id, req.user.sub);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.approved',
      targetType: 'Agent',
      targetId: id,
    });
    return { approved: true };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('agents:review')
  async reject(@Param('id') id: string, @Body() dto: RejectAgentDto, @Req() req: { user: JwtPayload }) {
    await this.adminAgentReviewService.reject(id, req.user.sub, dto.reason);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.rejected',
      targetType: 'Agent',
      targetId: id,
      metadata: { reason: dto.reason },
    });
    return { rejected: true };
  }

  @Post(':id/resend-credentials')
  @HttpCode(200)
  @RequirePermissions('agents:review')
  async resendCredentials(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminAgentReviewService.resendCredentials(id, req.user.sub);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.credentials_resent',
      targetType: 'Agent',
      targetId: id,
    });
    return { resent: true };
  }
}

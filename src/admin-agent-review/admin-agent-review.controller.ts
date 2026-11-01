import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors, OnModuleInit } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { AdminAgentAnalyticsService } from './admin-agent-analytics.service';
import { RejectAgentDto } from './dto/reject-agent.dto';
import { ListAgentsQueryDto } from './dto/list-agents-query.dto';
import { SetOnboardingAccessDto } from './dto/set-onboarding-access.dto';
import { AgentAnalyticsQueryDto } from './dto/agent-analytics-query.dto';
import { AuditActorType } from '../generated/prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';

const AGENT_APPROVE = 'agent.approve';
const AGENT_RESEND_CREDENTIALS = 'agent.resend_credentials';

@Controller('admin/agents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminAgentReviewController implements OnModuleInit {
  constructor(
    private readonly adminAgentReviewService: AdminAgentReviewService,
    private readonly auditLogService: AuditLogService,
    private readonly adminAgentAnalyticsService: AdminAgentAnalyticsService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  onModuleInit() {
    const agentEvent = (action: string, deciderId: string, id: string, requestedById: string) =>
      this.auditLogService.record({
        actorType: AuditActorType.ADMIN,
        actorId: deciderId,
        action,
        targetType: 'Agent',
        targetId: id,
        metadata: { requestedById },
      });

    this.approvalsService.register(AGENT_APPROVE, async (_payload, approval, deciderId) => {
      await this.adminAgentReviewService.approve(approval.targetId, deciderId);
      await agentEvent('agent.approved', deciderId, approval.targetId, approval.requestedById);
    });
    this.approvalsService.register(AGENT_RESEND_CREDENTIALS, async (_payload, approval, deciderId) => {
      await this.adminAgentReviewService.resendCredentials(approval.targetId, deciderId);
      await agentEvent('agent.credentials_resent', deciderId, approval.targetId, approval.requestedById);
    });
  }

  @Get()
  @RequirePermissions('agents:read')
  list(@Query() query: ListAgentsQueryDto) {
    return this.adminAgentReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        reviewedFrom: query.reviewedFrom ? new Date(query.reviewedFrom) : undefined,
        reviewedTo: query.reviewedTo ? new Date(query.reviewedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('analytics')
  @RequirePermissions('agents:analytics:read')
  getAnalytics(@Query() query: AgentAnalyticsQueryDto) {
    return this.adminAgentAnalyticsService.getSummary({
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
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
    const agent = await this.adminAgentReviewService.assertCanApprove(id);
    return this.approvalsService.submit({
      action: AGENT_APPROVE,
      requiredPermission: 'approvals:agents',
      targetType: 'Agent',
      targetId: id,
      summary: { title: 'Approve agent', subject: agent.fullName, details: [{ label: 'Email', value: agent.email }], link: `/dashboard/agent/${id}` },
      requestedById: req.user.sub,
    });
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
    const agent = await this.adminAgentReviewService.assertCanResendCredentials(id);
    return this.approvalsService.submit({
      action: AGENT_RESEND_CREDENTIALS,
      requiredPermission: 'approvals:agents',
      targetType: 'Agent',
      targetId: id,
      summary: { title: 'Resend agent sign-in code', subject: agent.fullName, details: [{ label: 'Email', value: agent.email }], link: `/dashboard/agent/${id}` },
      requestedById: req.user.sub,
    });
  }

  @Patch(':id/onboarding-access')
  @HttpCode(200)
  @RequirePermissions('agents:onboarding-access:manage')
  async setOnboardingAccess(
    @Param('id') id: string,
    @Body() dto: SetOnboardingAccessDto,
    @Req() req: { user: JwtPayload },
  ) {
    const agent = await this.adminAgentReviewService.setOnboardingAccess(id, dto.canOnboardClients);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.onboarding_access.changed',
      targetType: 'Agent',
      targetId: id,
      metadata: { canOnboardClients: dto.canOnboardClients },
    });
    return agent;
  }
}

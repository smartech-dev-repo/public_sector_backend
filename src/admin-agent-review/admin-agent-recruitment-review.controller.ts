import { Controller, Delete, Get, HttpCode, Param, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { AdminAgentRecruitmentReviewService } from './admin-agent-recruitment-review.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ListRecruitmentApplicationsQueryDto } from './dto/list-recruitment-applications-query.dto';
import { RecruitmentApplicationAnalyticsQueryDto } from './dto/recruitment-application-analytics-query.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/agent-recruitment-applications')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminAgentRecruitmentReviewController {
  constructor(
    private readonly adminAgentRecruitmentReviewService: AdminAgentRecruitmentReviewService,
    private readonly auditLogService: AuditLogService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  @Get()
  @RequirePermissions('agents:recruitment:read')
  async list(@Query() query: ListRecruitmentApplicationsQueryDto) {
    const result = await this.adminAgentRecruitmentReviewService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
    const agentIds = result.data.flatMap((row) => (row.submittedAgent ? [row.submittedAgent.id] : []));
    const pending = await this.approvalsService.pendingFor(agentIds);
    return {
      ...result,
      data: result.data.map((row) => ({
        ...row,
        pendingApproval: row.submittedAgent ? (pending.get(row.submittedAgent.id) ?? null) : null,
      })),
    };
  }

  @Get('analytics')
  @RequirePermissions('agents:recruitment:analytics:read')
  getAnalytics(@Query() query: RecruitmentApplicationAnalyticsQueryDto) {
    return this.adminAgentRecruitmentReviewService.getAnalytics({
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('agents:recruitment:read')
  findById(@Param('id') id: string) {
    return this.adminAgentRecruitmentReviewService.findById(id);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('agents:recruitment:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.adminAgentRecruitmentReviewService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent_recruitment_application.deleted',
      targetType: 'AgentApplication',
      targetId: id,
    });
    return { deleted: true };
  }
}

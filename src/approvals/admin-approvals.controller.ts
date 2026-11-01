import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditContextInterceptor } from '../audit/audit-context.interceptor';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ApprovalsService } from './approvals.service';
import { ApproveRequestDto } from './dto/approve-request.dto';
import { AssignApprovalDto } from './dto/assign-approval.dto';
import { ListApprovalsQueryDto } from './dto/list-approvals-query.dto';
import { RejectRequestDto } from './dto/reject-request.dto';

// Access is per request, not per route: it depends on the request's own permission and maker.
@Controller('admin/approvals')
@UseGuards(JwtAuthGuard, AdminOnlyGuard)
@UseInterceptors(AuditContextInterceptor)
export class AdminApprovalsController {
  constructor(private readonly approvalsService: ApprovalsService) {}

  @Get()
  list(@Query() query: ListApprovalsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.list(
      req.user,
      { view: query.view, status: query.status, action: query.action },
      { page: query.page, limit: query.limit },
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.findById(req.user, id);
  }

  @Get(':id/assignees')
  listAssignees(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.listAssignees(req.user, id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(@Param('id') id: string, @Body() dto: AssignApprovalDto, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.assign(req.user, id, dto.assigneeId ?? null);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Param('id') id: string, @Body() dto: ApproveRequestDto, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.approve(req.user, id, dto.note);
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Param('id') id: string, @Body() dto: RejectRequestDto, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.reject(req.user, id, dto.note);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.approvalsService.cancel(req.user, id);
  }
}

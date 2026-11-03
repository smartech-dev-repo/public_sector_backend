import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors, OnModuleInit } from '@nestjs/common';
import { ApprovalsService, ApprovalSummary } from '../approvals/approvals.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, LoanRequestStatus } from '../generated/prisma/client';
import { LoanRequestService } from './loan-request.service';
import { RejectLoanRequestDto } from './dto/reject-loan-request.dto';
import { ListAdminLoanRequestsQueryDto } from './dto/list-admin-loan-requests-query.dto';
import { DisbursementDateDto } from './dto/disbursement-date.dto';
import { ConfirmLoanRequestCodeDto } from './dto/confirm-loan-request-code.dto';
import { clientScope } from '../common/client-scope.util';

const LOAN_APPROVE = 'loan-request.approve';
const LOAN_DISBURSE = 'loan-request.disburse';
const LOAN_CONFIRM_CODE = 'loan-request.confirm_code';

@Controller('admin/loan-requests')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-requests:read')
@UseInterceptors(AuditInterceptor)
export class AdminLoanRequestController implements OnModuleInit {
  constructor(
    private readonly loanRequestService: LoanRequestService,
    private readonly auditLogService: AuditLogService,
    private readonly approvalsService: ApprovalsService,
  ) {}

  onModuleInit() {
    const date = (payload: Record<string, unknown>) => (payload.disbursedAt ? new Date(String(payload.disbursedAt)) : undefined);

    this.approvalsService.register(LOAN_APPROVE, async (payload, approval, deciderId) => {
      await this.loanRequestService.approve(approval.targetId, date(payload));
      await this.loanEvent('loan-request.approve', deciderId, approval.targetId, approval.requestedById);
    });
    this.approvalsService.register(LOAN_DISBURSE, async (payload, approval, deciderId) => {
      await this.loanRequestService.disburse(approval.targetId, date(payload));
      await this.loanEvent('loan-request.disburse', deciderId, approval.targetId, approval.requestedById);
    });
    this.approvalsService.register(LOAN_CONFIRM_CODE, async (_payload, approval, deciderId) => {
      await this.loanRequestService.confirmAfterApproval(approval.targetId);
      await this.loanEvent('loan-request.confirm-code', deciderId, approval.targetId, approval.requestedById);
    });
  }

  @Get()
  async list(@Query() query: ListAdminLoanRequestsQueryDto, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.listAll(
      {
        scope: clientScope(req.user),
        search: query.search,
        status: query.status,
        type: query.type,
        clientId: query.clientId,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
    const pending = await this.approvalsService.pendingFor(result.data.map((row) => row.id));
    return {
      ...result,
      data: result.data.map((row) => this.withActions(row, pending.get(row.id) ?? null)),
    };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.assertInScope(id, req.user);
    const loanRequest = await this.loanRequestService.findById(id);
    const pending = await this.approvalsService.pendingFor([id]);
    return this.withActions(loanRequest, pending.get(id) ?? null);
  }

  /** Nothing can be done to a loan while a decision on it waits in Approvals. */
  private withActions<T extends { availableActions: string[] }>(row: T, pendingApproval: unknown) {
    return { ...row, pendingApproval, availableActions: pendingApproval ? [] : row.availableActions };
  }

  @Post(':id/approve')
  @RequirePermissions('loan-requests:manage')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() dto: DisbursementDateDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.assertInScope(id, req.user);
    const loan = await this.loanRequestService.requireStatus(id, LoanRequestStatus.CONFIRMED, 'approve');
    return this.approvalsService.submit({
      action: LOAN_APPROVE,
      requiredPermission: 'approvals:loans',
      targetType: 'LoanRequest',
      targetId: id,
      summary: this.loanSummary('Approve and disburse loan', loan),
      payload: { disbursedAt: dto.disbursedAt ?? null },
      requestedById: req.user.sub,
    });
  }

  @Post(':id/confirm-code')
  @RequirePermissions('loan-requests:confirm-code')
  @HttpCode(200)
  async confirmCode(@Param('id') id: string, @Body() dto: ConfirmLoanRequestCodeDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.assertInScope(id, req.user);
    // Checked here and never stored, so the code isn't passed along to the checker.
    await this.loanRequestService.checkConfirmationCode(id, dto.code);
    const loan = await this.loanRequestService.requireStatus(id, LoanRequestStatus.PENDING, 'confirm');
    return this.approvalsService.submit({
      action: LOAN_CONFIRM_CODE,
      requiredPermission: 'approvals:loans',
      targetType: 'LoanRequest',
      targetId: id,
      summary: this.loanSummary('Confirm loan with client code', loan),
      requestedById: req.user.sub,
    });
  }

  @Post(':id/reject')
  @RequirePermissions('loan-requests:reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() dto: RejectLoanRequestDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.assertInScope(id, req.user);
    const result = await this.loanRequestService.reject(id, dto.reason);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.reject',
      targetType: 'LoanRequest',
      targetId: id,
      metadata: { reason: dto.reason },
    });
    return result;
  }

  @Post(':id/disburse')
  @RequirePermissions('loan-requests:disburse')
  @HttpCode(200)
  async disburse(@Param('id') id: string, @Body() dto: DisbursementDateDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.assertInScope(id, req.user);
    const loan = await this.loanRequestService.requireStatus(id, LoanRequestStatus.APPROVED, 'disburse');
    return this.approvalsService.submit({
      action: LOAN_DISBURSE,
      requiredPermission: 'approvals:loans',
      targetType: 'LoanRequest',
      targetId: id,
      summary: this.loanSummary('Disburse loan', loan),
      payload: { disbursedAt: dto.disbursedAt ?? null },
      requestedById: req.user.sub,
    });
  }

  private loanSummary(
    title: string,
    loan: Awaited<ReturnType<LoanRequestService['requireStatus']>>,
  ): ApprovalSummary {
    return {
      title,
      subject: loan.client.onboarding?.employeeName ?? loan.client.phone,
      details: [
        { label: 'Amount', value: `₦${Number(loan.amount).toLocaleString('en-NG')}` },
        { label: 'Tenor', value: `${loan.tenorMonths} months` },
        { label: 'Type', value: loan.type === 'TOPUP' ? 'Top-up' : 'New loan' },
      ],
      link: `/dashboard/loan-requests/${loan.id}`,
    };
  }

  private loanEvent(action: string, deciderId: string, id: string, requestedById: string) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: deciderId,
      action,
      targetType: 'LoanRequest',
      targetId: id,
      metadata: { requestedById },
    });
  }
}

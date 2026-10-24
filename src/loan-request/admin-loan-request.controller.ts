import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType } from '../generated/prisma/client';
import { LoanRequestService } from './loan-request.service';
import { RejectLoanRequestDto } from './dto/reject-loan-request.dto';
import { ListAdminLoanRequestsQueryDto } from './dto/list-admin-loan-requests-query.dto';
import { DisbursementDateDto } from './dto/disbursement-date.dto';
import { ConfirmLoanRequestCodeDto } from './dto/confirm-loan-request-code.dto';

@Controller('admin/loan-requests')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-requests:review')
@UseInterceptors(AuditInterceptor)
export class AdminLoanRequestController {
  constructor(
    private readonly loanRequestService: LoanRequestService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  list(@Query() query: ListAdminLoanRequestsQueryDto) {
    return this.loanRequestService.listAll(
      {
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
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.loanRequestService.findById(id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  async approve(@Param('id') id: string, @Body() dto: DisbursementDateDto, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.approve(id, dto.disbursedAt ? new Date(dto.disbursedAt) : undefined);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.approve',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return result;
  }

  @Post(':id/confirm-code')
  @HttpCode(200)
  async confirmCode(@Param('id') id: string, @Body() dto: ConfirmLoanRequestCodeDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.adminConfirmByCode(id, dto.code);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.confirm-code',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return { confirmed: true };
  }

  @Post(':id/reject')
  @HttpCode(200)
  async reject(@Param('id') id: string, @Body() dto: RejectLoanRequestDto, @Req() req: { user: JwtPayload }) {
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
  @HttpCode(200)
  async disburse(@Param('id') id: string, @Body() dto: DisbursementDateDto, @Req() req: { user: JwtPayload }) {
    const result = await this.loanRequestService.disburse(id, dto.disbursedAt ? new Date(dto.disbursedAt) : undefined);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-request.disburse',
      targetType: 'LoanRequest',
      targetId: id,
    });
    return result;
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditEvent } from '../audit/audit-event.decorator';
import { AuditEventInterceptor } from '../audit/audit-event.interceptor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { ConfirmLoanRequestCodeDto } from './dto/confirm-loan-request-code.dto';
import { ListClientLoanRequestsQueryDto } from './dto/list-client-loan-requests-query.dto';
import { LoanEligibilityQueryDto } from './dto/loan-eligibility-query.dto';
import { AffordabilityService } from './eligibility/affordability/affordability.service';

@Controller('client/loan-requests')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
@UseInterceptors(AuditEventInterceptor)
export class LoanRequestController {
  constructor(
    private readonly loanRequestService: LoanRequestService,
    private readonly affordabilityService: AffordabilityService,
  ) {}

  /** The most the client can borrow or top up over the tenor they picked. */
  @Get('eligibility')
  eligibility(@Query() query: LoanEligibilityQueryDto, @Req() req: { user: JwtPayload }) {
    return this.affordabilityService.preview(req.user.sub, query.tenorMonths, query.type, query.amount);
  }

  @Post()
  @AuditEvent({ action: 'loan-request.created', targetType: 'LoanRequest', targetId: { result: 'id' }, result: ['amount', 'tenorMonths', 'status', 'type'] })
  create(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.create(req.user.sub, dto.amount, dto.tenorMonths);
  }

  @Post('topup')
  @AuditEvent({ action: 'loan-request.topup_created', targetType: 'LoanRequest', targetId: { result: 'id' }, result: ['amount', 'tenorMonths', 'status', 'type'] })
  createTopup(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.createTopup(req.user.sub, dto.amount, dto.tenorMonths);
  }

  @Post(':id/resend')
  @AuditEvent({ action: 'loan-request.code_resent', targetType: 'LoanRequest', targetId: { param: 'id' } })
  @HttpCode(200)
  resend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.resend(req.user.sub, id);
  }

  @Post(':id/confirm-code')
  @AuditEvent({ action: 'loan-request.code_confirmed', targetType: 'LoanRequest', targetId: { param: 'id' } })
  @HttpCode(200)
  async confirmCode(@Param('id') id: string, @Body() dto: ConfirmLoanRequestCodeDto, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.confirmByCode(req.user.sub, id, dto.code);
    return { confirmed: true };
  }

  @Get()
  list(@Query() query: ListClientLoanRequestsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.list(req.user.sub, { status: query.status }, { page: query.page, limit: query.limit });
  }
}

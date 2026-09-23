import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { LoanRequestService } from './loan-request.service';
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { ListClientLoanRequestsQueryDto } from './dto/list-client-loan-requests-query.dto';

@Controller('client/loan-requests')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class LoanRequestController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Post()
  create(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.create(req.user.sub, dto.amount, dto.tenorMonths);
  }

  @Post('topup')
  createTopup(@Body() dto: CreateLoanRequestDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.createTopup(req.user.sub, dto.amount, dto.tenorMonths);
  }

  @Post(':id/resend')
  @HttpCode(200)
  resend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.resend(req.user.sub, id);
  }

  @Get()
  list(@Query() query: ListClientLoanRequestsQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.list(req.user.sub, { status: query.status }, { page: query.page, limit: query.limit });
  }
}

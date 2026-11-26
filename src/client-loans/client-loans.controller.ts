import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientLoansService } from './client-loans.service';
import { ListLoansQueryDto } from './dto/list-loans-query.dto';

@Controller('client/loans')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientLoansController {
  constructor(private readonly clientLoansService: ClientLoansService) {}

  @Get()
  getDashboard(@Query() query: ListLoansQueryDto, @Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getDashboard(
      req.user.sub,
      {
        status: query.status,
        product: query.product,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get(':loanId/repayment-plan')
  getRepaymentPlan(@Param('loanId') loanId: string, @Req() req: { user: JwtPayload }) {
    return this.clientLoansService.getRepaymentPlan(req.user.sub, loanId);
  }
}

import { Controller, Get, Header, Param, Query, Req, UseGuards } from '@nestjs/common';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { clientScope } from '../common/client-scope.util';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanRequestService } from './loan-request.service';
import { ListClientLoansQueryDto } from './dto/list-client-loans-query.dto';

@Controller('admin/client-loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('client-loans:read')
export class AdminClientLoansController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Get()
  @RequirePermissions('clients:read')
  list(@Query() query: ListClientLoansQueryDto, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.listByClient(
      query.clientId,
      {
        scope: clientScope(req.user),
        search: query.search,
        status: query.status,
        agency: query.agency,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get('disbursement-summary')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="disbursement-summary.csv"')
  exportDisbursementSummary(@Query('month') month: string, @Req() req: { user: JwtPayload }) {
    return this.loanRequestService.exportDisbursementSummaryCsv(month, clientScope(req.user));
  }

  @Get(':id/repayment-plan')
  async getRepaymentPlan(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.loanRequestService.assertClientLoanInScope(id, req.user);
    return this.loanRequestService.getRepaymentPlanById(id);
  }
}

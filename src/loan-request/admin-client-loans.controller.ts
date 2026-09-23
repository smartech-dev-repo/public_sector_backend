import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
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
  list(@Query() query: ListClientLoansQueryDto) {
    return this.loanRequestService.listByClient(
      query.clientId,
      {
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
  exportDisbursementSummary(@Query('month') month: string) {
    return this.loanRequestService.exportDisbursementSummaryCsv(month);
  }

  @Get(':id/repayment-plan')
  getRepaymentPlan(@Param('id') id: string) {
    return this.loanRequestService.getRepaymentPlanById(id);
  }
}

import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanRequestService } from './loan-request.service';

@Controller('admin/client-loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('client-loans:read')
export class AdminClientLoansController {
  constructor(private readonly loanRequestService: LoanRequestService) {}

  @Get('disbursement-summary')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="disbursement-summary.csv"')
  exportDisbursementSummary(@Query('month') month: string) {
    return this.loanRequestService.exportDisbursementSummaryCsv(month);
  }
}

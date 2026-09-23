import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ReconciliationService } from './reconciliation.service';
import { ListReconciliationQueryDto } from './dto/list-reconciliation-query.dto';

@Controller('admin/reconciliation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get()
  @RequirePermissions('reconciliation:read')
  list(@Query() query: ListReconciliationQueryDto) {
    return this.reconciliationService.list(
      {
        agency: query.agency,
        status: query.status,
        period: query.period,
        generatedFrom: query.generatedFrom ? new Date(query.generatedFrom) : undefined,
        generatedTo: query.generatedTo ? new Date(query.generatedTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}

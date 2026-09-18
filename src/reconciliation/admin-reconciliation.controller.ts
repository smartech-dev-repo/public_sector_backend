import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ReconciliationService } from './reconciliation.service';
import { VarianceStatus } from '../generated/prisma/client';

@Controller('admin/reconciliation')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminReconciliationController {
  constructor(private readonly reconciliationService: ReconciliationService) {}

  @Get()
  @RequirePermissions('reconciliation:read')
  list(
    @Query('agency') agency?: string,
    @Query('status') status?: VarianceStatus,
    @Query('period') period?: string,
  ) {
    return this.reconciliationService.list({ agency, status, period });
  }
}

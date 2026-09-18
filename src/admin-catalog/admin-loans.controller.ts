import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';

@Controller('admin/loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminLoansController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('loans:upload')
  list(@Query('agency') agency?: string) {
    return this.adminCatalogService.listLoans(agency);
  }
}

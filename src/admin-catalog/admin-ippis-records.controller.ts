import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';

@Controller('admin/ippis-records')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminIppisRecordsController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('ippis:upload')
  list(@Query('agency') agency?: string) {
    return this.adminCatalogService.listIppisRecords(agency);
  }
}

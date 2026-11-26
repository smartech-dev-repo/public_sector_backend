import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';
import { ListIppisRecordsQueryDto } from './dto/list-ippis-records-query.dto';

@Controller('admin/ippis-records')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminIppisRecordsController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('ippis:upload')
  list(@Query() query: ListIppisRecordsQueryDto) {
    return this.adminCatalogService.listIppisRecords(
      {
        agency: query.agency,
        employeeStatus: query.employeeStatus,
        department: query.department,
        grade: query.grade,
        q: query.q,
        hireDateFrom: query.hireDateFrom ? new Date(query.hireDateFrom) : undefined,
        hireDateTo: query.hireDateTo ? new Date(query.hireDateTo) : undefined,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}

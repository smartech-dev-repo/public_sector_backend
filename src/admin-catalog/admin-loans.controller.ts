import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminCatalogService } from './admin-catalog.service';
import { ListAdminLoansQueryDto } from './dto/list-admin-loans-query.dto';

@Controller('admin/loans')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminLoansController {
  constructor(private readonly adminCatalogService: AdminCatalogService) {}

  @Get()
  @RequirePermissions('loans:upload')
  list(@Query() query: ListAdminLoansQueryDto) {
    return this.adminCatalogService.listLoans(
      {
        agency: query.agency,
        product: query.product,
        q: query.q,
        disbursedFrom: query.disbursedFrom ? new Date(query.disbursedFrom) : undefined,
        disbursedTo: query.disbursedTo ? new Date(query.disbursedTo) : undefined,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { ManagementFeesService } from './management-fees.service';
import { CreateManagementFeeDto } from './dto/create-management-fee.dto';
import { UpdateManagementFeeDto } from './dto/update-management-fee.dto';
import { ListManagementFeesQueryDto } from './dto/list-management-fees-query.dto';

@Controller('admin/management-fees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('management-fees:manage')
export class AdminManagementFeesController {
  constructor(private readonly managementFeesService: ManagementFeesService) {}

  @Post()
  create(@Body() dto: CreateManagementFeeDto) {
    return this.managementFeesService.create(dto);
  }

  @Get()
  list(@Query() query: ListManagementFeesQueryDto) {
    return this.managementFeesService.list({ q: query.q, isActive: query.isActive }, { page: query.page, limit: query.limit });
  }

  @Patch(':id')
  @HttpCode(200)
  update(@Param('id') id: string, @Body() dto: UpdateManagementFeeDto) {
    return this.managementFeesService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string) {
    await this.managementFeesService.remove(id);
    return { deleted: true };
  }
}

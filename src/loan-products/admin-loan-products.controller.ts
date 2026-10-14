import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanProductsService } from './loan-products.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { ListAdminLoanProductsQueryDto } from './dto/list-admin-loan-products-query.dto';
import { KNOWN_AGENCIES } from '../common/known-agencies.constant';

@Controller('admin/loan-products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-products:manage')
export class AdminLoanProductsController {
  constructor(private readonly loanProductsService: LoanProductsService) {}

  @Get('sectors')
  sectors() {
    return { sectors: KNOWN_AGENCIES };
  }

  @Post()
  create(@Body() dto: CreateLoanProductDto) {
    return this.loanProductsService.create(dto);
  }

  @Get()
  list(@Query() query: ListAdminLoanProductsQueryDto) {
    return this.loanProductsService.list(
      { sectors: query.sectors, isActive: query.isActive },
      { page: query.page, limit: query.limit },
    );
  }

  @Patch(':id')
  @HttpCode(200)
  update(@Param('id') id: string, @Body() dto: UpdateLoanProductDto) {
    return this.loanProductsService.update(id, dto);
  }
}

import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanTermOptionService } from './loan-terms.service';
import { CreateLoanTermOptionDto } from './dto/create-loan-term-option.dto';
import { UpdateLoanTermOptionDto } from './dto/update-loan-term-option.dto';
import { ListAdminLoanTermsQueryDto } from './dto/list-admin-loan-terms-query.dto';

@Controller('admin/loan-terms')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-terms:manage')
export class AdminLoanTermsController {
  constructor(private readonly loanTermOptionService: LoanTermOptionService) {}

  @Post()
  create(@Body() dto: CreateLoanTermOptionDto) {
    return this.loanTermOptionService.create(dto);
  }

  @Get()
  list(@Query() query: ListAdminLoanTermsQueryDto) {
    return this.loanTermOptionService.list(
      { agency: query.agency, isActive: query.isActive },
      { page: query.page, limit: query.limit },
    );
  }

  @Patch(':id')
  @HttpCode(200)
  update(@Param('id') id: string, @Body() dto: UpdateLoanTermOptionDto) {
    return this.loanTermOptionService.update(id, dto);
  }
}

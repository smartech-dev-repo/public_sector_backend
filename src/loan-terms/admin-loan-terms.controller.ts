import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanTermOptionService } from './loan-terms.service';
import { CreateLoanTermOptionDto } from './dto/create-loan-term-option.dto';
import { UpdateLoanTermOptionDto } from './dto/update-loan-term-option.dto';

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
  list(@Query('agency') agency?: string) {
    return this.loanTermOptionService.list(agency);
  }

  @Patch(':id')
  @HttpCode(200)
  update(@Param('id') id: string, @Body() dto: UpdateLoanTermOptionDto) {
    return this.loanTermOptionService.update(id, dto);
  }
}

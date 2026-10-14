import { Body, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { LoanSettingsService } from './loan-settings.service';
import { UpdateLoanSettingsDto } from './dto/update-loan-settings.dto';

@Controller('admin/loan-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('loan-settings:manage')
export class AdminLoanSettingsController {
  constructor(private readonly loanSettingsService: LoanSettingsService) {}

  @Get()
  get() {
    return this.loanSettingsService.get();
  }

  @Patch()
  @HttpCode(200)
  update(@Body() dto: UpdateLoanSettingsDto) {
    return this.loanSettingsService.update(dto);
  }
}

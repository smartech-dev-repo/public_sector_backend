import { Body, Controller, Get, HttpCode, Patch, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { auditChanges } from '../audit/audit-changes.util';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { LoanSettingsService } from './loan-settings.service';
import { UpdateLoanSettingsDto } from './dto/update-loan-settings.dto';

@Controller('admin/loan-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('loan-settings:manage')
export class AdminLoanSettingsController {
  constructor(
    private readonly loanSettingsService: LoanSettingsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  get() {
    return this.loanSettingsService.get();
  }

  @Patch()
  @HttpCode(200)
  async update(@Body() dto: UpdateLoanSettingsDto, @Req() req: { user: JwtPayload }) {
    const before = await this.loanSettingsService.get();
    const settings = await this.loanSettingsService.update(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-settings.updated',
      metadata: { changes: auditChanges(before, settings, ['retirementAgeYears', 'maxServiceYears', 'loanApprovalPhone']) } as Prisma.InputJsonObject,
    });
    return settings;
  }
}

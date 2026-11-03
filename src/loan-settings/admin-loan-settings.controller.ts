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
    return this.loanSettingsService.getWithSalaryPatterns();
  }

  @Patch()
  @HttpCode(200)
  async update(@Body() dto: UpdateLoanSettingsDto, @Req() req: { user: JwtPayload }) {
    const before = await this.loanSettingsService.getWithSalaryPatterns();
    await this.loanSettingsService.update(dto);
    const settings = await this.loanSettingsService.getWithSalaryPatterns();
    const changes = auditChanges(before, settings, [
      'retirementAgeYears',
      'maxServiceYears',
      'loanApprovalPhone',
      'affordabilityMethod',
      'basePayAmount',
      'dtiPercent',
    ]);
    // One entry per salary pattern whose outcome changed, e.g. "salaryPattern.ABC".
    for (const row of settings.salaryPatterns) {
      const from = before.salaryPatternOutcomes[row.pattern];
      if (from !== row.outcome) changes[`salaryPattern.${row.pattern}`] = { from, to: row.outcome };
    }
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-settings.updated',
      metadata: { changes } as Prisma.InputJsonObject,
    });
    return settings;
  }
}

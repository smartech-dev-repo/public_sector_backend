import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { auditChanges } from '../audit/audit-changes.util';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { FaceMatchSettingsService } from './face-match-settings.service';
import { UpdateFaceMatchSettingsDto } from './dto/update-face-match-settings.dto';

@Controller('admin/face-match-settings')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('face-match:manage')
export class AdminFaceMatchSettingsController {
  constructor(
    private readonly settingsService: FaceMatchSettingsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  get() {
    return this.settingsService.getWithEngine();
  }

  @Patch()
  @HttpCode(200)
  async update(
    @Body() dto: UpdateFaceMatchSettingsDto,
    @Req() req: { user: JwtPayload },
  ) {
    const before = await this.settingsService.get();
    const after = await this.settingsService.update(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'face-match-settings.updated',
      metadata: {
        changes: auditChanges(before, after, ['enabled', 'minimumScore']),
      } as Prisma.InputJsonObject,
    });
    return this.settingsService.getWithEngine();
  }
}

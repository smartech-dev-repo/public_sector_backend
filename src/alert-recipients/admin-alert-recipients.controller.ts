import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { auditChanges } from '../audit/audit-changes.util';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { AlertRecipientsService } from './alert-recipients.service';
import { CreateAlertRecipientDto } from './dto/create-alert-recipient.dto';
import { UpdateAlertRecipientDto } from './dto/update-alert-recipient.dto';

@Controller('admin/alert-recipients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('alerts:manage')
export class AdminAlertRecipientsController {
  constructor(
    private readonly alertRecipientsService: AlertRecipientsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private recordEvent(req: { user: JwtPayload }, action: string, id: string, metadata: Prisma.InputJsonObject) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action,
      targetType: 'AlertRecipient',
      targetId: id,
      metadata,
    });
  }

  @Get()
  list() {
    return this.alertRecipientsService.list();
  }

  @Post()
  async create(@Body() dto: CreateAlertRecipientDto, @Req() req: { user: JwtPayload }) {
    const recipient = await this.alertRecipientsService.create(dto);
    await this.recordEvent(req, 'alert-recipient.added', recipient.id, { recipient: recipient.email });
    return recipient;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateAlertRecipientDto, @Req() req: { user: JwtPayload }) {
    const before = await this.alertRecipientsService.findById(id);
    const recipient = await this.alertRecipientsService.update(id, dto);
    await this.recordEvent(req, 'alert-recipient.updated', id, {
      changes: auditChanges(before, recipient, ['email', 'name', 'isActive']),
    } as Prisma.InputJsonObject);
    return recipient;
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const recipient = await this.alertRecipientsService.remove(id);
    await this.recordEvent(req, 'alert-recipient.removed', id, { recipient: recipient.email });
    return { deleted: true };
  }
}

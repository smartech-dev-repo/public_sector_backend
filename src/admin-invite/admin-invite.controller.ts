import { Body, Controller, Get, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { EmailService } from '../email/email.service';
import { AdminInviteService } from './admin-invite.service';
import { CreateInviteDto } from './dto/create-invite.dto';
import { ListInvitesQueryDto } from './dto/list-invites-query.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/invites')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminInviteController {
  constructor(
    private readonly adminInviteService: AdminInviteService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('admins:create')
  async create(@Body() dto: CreateInviteDto, @Req() req: { user: JwtPayload }) {
    const { invite, token } = await this.adminInviteService.create({
      email: dto.email,
      roleId: dto.roleId,
      invitedById: req.user.sub,
    });

    await this.emailService.send({
      to: dto.email,
      subject: 'You have been invited as an admin',
      html: `<p>You have been invited. Use this token to accept: ${token}</p>`,
      text: `You have been invited. Use this token to accept: ${token}`,
    });

    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.invite.created',
      targetType: 'AdminInvite',
      targetId: invite.id,
      metadata: { email: dto.email, roleId: dto.roleId },
    });

    return { id: invite.id, email: invite.email, status: invite.status, expiresAt: invite.expiresAt };
  }

  @Post(':id/resend')
  @RequirePermissions('admins:create')
  async resend(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const { invite, token } = await this.adminInviteService.resend(id);

    await this.emailService.send({
      to: invite.email,
      subject: 'Your admin invitation (resent)',
      html: `<p>Use this token to accept: ${token}</p>`,
      text: `Use this token to accept: ${token}`,
    });

    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'admin.invite.resent',
      targetType: 'AdminInvite',
      targetId: invite.id,
    });

    return { id: invite.id, email: invite.email, status: invite.status, expiresAt: invite.expiresAt };
  }

  @Get()
  @RequirePermissions('admins:create')
  list(@Query() query: ListInvitesQueryDto) {
    return this.adminInviteService.list(
      {
        status: query.status,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        expiresFrom: query.expiresFrom ? new Date(query.expiresFrom) : undefined,
        expiresTo: query.expiresTo ? new Date(query.expiresTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );
  }
}

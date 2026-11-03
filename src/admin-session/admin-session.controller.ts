import { ClientInScope } from '../auth/client-scope.guard';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { SessionService } from '../session/session.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { ListUserSessionsQueryDto } from './dto/list-user-sessions-query.dto';
import { RevokeUserSessionsDto } from './dto/revoke-user-sessions.dto';
import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';

const SESSION_TARGET_TYPES: Record<SessionPrincipalType, string> = {
  ADMIN: 'AdminUser',
  AGENT: 'Agent',
  CLIENT: 'Client',
};

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminSessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly auditLogService: AuditLogService,
    private readonly principalResolver: PrincipalResolverService,
  ) {}

  @Get('sessions')
  @RequirePermissions('sessions:manage')
  async listUserSessions(@Query() query: ListUserSessionsQueryDto) {
    const result = await this.sessionService.listForAdmin(
      {
        userType: query.userType,
        userId: query.userId,
        status: query.status,
        idsByType: query.q ? await this.principalResolver.searchIds(query.q) : undefined,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
      },
      { page: query.page, limit: query.limit },
    );

    const users = await this.principalResolver.resolveMany(
      result.data.map((session) => ({ type: session.principalType, id: session.principalId })),
    );
    return {
      ...result,
      data: result.data.map((session) => ({
        ...session,
        user: users.get(`${session.principalType}:${session.principalId}`) ?? null,
      })),
    };
  }

  // Declared before ':id/revoke' so it isn't read as a session id.
  @Post('sessions/revoke-user')
  @HttpCode(200)
  @RequirePermissions('sessions:manage')
  async revokeUserSessions(@Body() dto: RevokeUserSessionsDto, @Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(dto.userType, dto.userId, 'admin_forced');
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'sessions.revoked_for_user',
      targetType: SESSION_TARGET_TYPES[dto.userType],
      targetId: dto.userId,
    });
    return { revoked: true };
  }

  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @RequirePermissions('sessions:manage')
  async revokeUserSession(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const session = await this.sessionService.revokeById(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'session.revoked',
      targetType: SESSION_TARGET_TYPES[session.principalType],
      targetId: session.principalId,
      metadata: { ip: session.ip, device: session.userAgent },
    });
    return { revoked: true };
  }

  @Post('agents/:id/sessions/revoke-all')
  @HttpCode(200)
  @RequirePermissions('agents:sessions:revoke')
  async revokeAgentSessions(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, id, 'admin_forced');
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'agent.sessions.revoked',
      targetType: 'Agent',
      targetId: id,
    });
    return { revoked: true };
  }

  @Post('clients/:id/sessions/revoke-all')
  @ClientInScope('id')
  @HttpCode(200)
  @RequirePermissions('clients:sessions:revoke')
  async revokeClientSessions(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.CLIENT, id, 'admin_forced');
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'client.sessions.revoked',
      targetType: 'Client',
      targetId: id,
    });
    return { revoked: true };
  }
}

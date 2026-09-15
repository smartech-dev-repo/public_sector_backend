import { Controller, HttpCode, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { SessionService } from '../session/session.service';
import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';

@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminSessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly auditLogService: AuditLogService,
  ) {}

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

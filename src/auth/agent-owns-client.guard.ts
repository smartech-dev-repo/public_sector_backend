import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Request } from 'express';
import { AuditLogService } from '../audit/audit-log.service';
import { getRequestMetadata } from '../common/request-metadata.util';
import { AuditActorType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from './jwt-payload.interface';

/** Limits a `:clientId` route to the agent who onboarded that client. Answers 404, so an agent can't probe which clients exist. */
@Injectable()
export class AgentOwnsClientGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: JwtPayload }>();
    const clientId = String(request.params.clientId);
    const agentId = request.user?.sub;

    const owned = await this.prisma.client.findFirst({
      where: { id: clientId, assignedAgentId: agentId },
      select: { id: true },
    });
    if (owned) {
      return true;
    }

    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: 'agent.client_access.denied',
      targetType: 'Client',
      targetId: clientId,
      metadata: { method: request.method, route: request.route?.path ?? null },
      ...getRequestMetadata(request),
    });
    throw new NotFoundException('Client not found');
  }
}

import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { generateOpaqueToken, hashToken } from '../common/opaque-token.util';
import { AuditActorType, Prisma, SessionPrincipalType } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateSessionParams {
  principalType: SessionPrincipalType;
  principalId: string;
  userAgent?: string;
  ip?: string;
}

export interface RotateResult {
  refreshToken: string;
  principalType: SessionPrincipalType;
  principalId: string;
}

export interface SessionSummary {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

const SESSION_AUDIT_NAMES: Record<SessionPrincipalType, { prefix: string; targetType: string }> = {
  ADMIN: { prefix: 'admin', targetType: 'AdminUser' },
  AGENT: { prefix: 'agent', targetType: 'Agent' },
  CLIENT: { prefix: 'client', targetType: 'Client' },
};

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createSession(params: CreateSessionParams): Promise<string> {
    const token = generateOpaqueToken();

    await this.prisma.session.create({
      data: {
        principalType: params.principalType,
        principalId: params.principalId,
        refreshTokenHash: hashToken(token),
        userAgent: params.userAgent,
        ip: params.ip,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });

    return token;
  }

  async rotate(
    refreshToken: string,
    meta?: { userAgent?: string; ip?: string },
  ): Promise<RotateResult> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.revokedAt) {
      await this.revokeAllForPrincipal(session.principalType, session.principalId, 'reuse_detected');
      const targetType: Record<SessionPrincipalType, string> = {
        ADMIN: 'AdminUser',
        AGENT: 'Agent',
        CLIENT: 'Client',
      };
      await this.auditLogService.record({
        actorType: AuditActorType.SYSTEM,
        action: 'session.reuse_detected',
        targetType: targetType[session.principalType],
        targetId: session.principalId,
        metadata: { principalType: session.principalType },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (session.expiresAt < new Date()) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedReason: 'expired' },
      });
      throw new UnauthorizedException('Invalid refresh token');
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'rotated' },
    });

    const newToken = await this.createSession({
      principalType: session.principalType,
      principalId: session.principalId,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      refreshToken: newToken,
      principalType: session.principalType,
      principalId: session.principalId,
    };
  }

  async revokeByToken(refreshToken: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
    });

    if (!session || session.revokedAt) {
      return;
    }

    await this.prisma.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
    await this.recordLogout(session.principalType, session.principalId, 'logout');
  }

  private recordLogout(principalType: SessionPrincipalType, principalId: string, action: string) {
    const { prefix, targetType } = SESSION_AUDIT_NAMES[principalType];
    return this.auditLogService.recordSafely({
      actorType: AuditActorType[principalType],
      actorId: principalId,
      action: `${prefix}.${action}`,
      targetType,
      targetId: principalId,
    });
  }

  async revokeAllForPrincipal(
    principalType: SessionPrincipalType,
    principalId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.session.updateMany({
      where: { principalType, principalId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (reason === 'logout_all') {
      await this.recordLogout(principalType, principalId, 'logout_all');
    }
  }

  async listActiveSessions(
    principalType: SessionPrincipalType,
    principalId: string,
    filters: { q?: string; createdFrom?: Date; createdTo?: Date } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<SessionSummary>> {
    const { page, limit } = pagination;
    const where: Prisma.SessionWhereInput = {
      principalType,
      principalId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      OR: filters.q
        ? [
            { ip: { contains: filters.q, mode: 'insensitive' } },
            { userAgent: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [sessions, total] = await Promise.all([
      this.prisma.session.findMany({ where, orderBy: { lastUsedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.session.count({ where }),
    ]);

    const data = sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ip: session.ip,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
    }));

    return buildPaginatedResult(data, total, page, limit);
  }

  /** Every user's sessions, for the back office, newest activity first. */
  async listForAdmin(
    filters: {
      userType?: SessionPrincipalType;
      userId?: string;
      status?: 'active' | 'revoked' | 'expired';
      idsByType?: Partial<Record<SessionPrincipalType, string[]>>;
      createdFrom?: Date;
      createdTo?: Date;
    },
    pagination: { page: number; limit: number },
  ) {
    const { page, limit } = pagination;
    const now = new Date();
    const statusWhere: Record<string, Prisma.SessionWhereInput> = {
      active: { revokedAt: null, expiresAt: { gt: now } },
      revoked: { revokedAt: { not: null } },
      expired: { revokedAt: null, expiresAt: { lte: now } },
    };
    const where: Prisma.SessionWhereInput = {
      ...(filters.status ? statusWhere[filters.status] : {}),
      principalType: filters.userType,
      principalId: filters.userId,
      OR: filters.idsByType
        ? Object.entries(filters.idsByType).map(([type, ids]) => ({
            principalType: type as SessionPrincipalType,
            principalId: { in: ids },
          }))
        : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [sessions, total] = await Promise.all([
      this.prisma.session.findMany({
        where,
        omit: { refreshTokenHash: true },
        orderBy: { lastUsedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.session.count({ where }),
    ]);

    const data = sessions.map((session) => ({
      ...session,
      status: session.revokedAt ? 'revoked' : session.expiresAt <= now ? 'expired' : 'active',
    }));
    return buildPaginatedResult(data, total, page, limit);
  }

  /** Signs out one session on an admin's instruction, and returns whose it was. */
  async revokeById(sessionId: string) {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.revokedAt) {
      throw new ConflictException('This session has already been signed out');
    }
    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: 'admin_forced' },
    });
    return session;
  }

  async revokeOwnSession(
    principalType: SessionPrincipalType,
    principalId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });

    if (!session || session.principalType !== principalType || session.principalId !== principalId) {
      throw new NotFoundException('Session not found');
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: 'logout' },
    });
    await this.recordLogout(session.principalType, session.principalId, 'logout');
  }
}

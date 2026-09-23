import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
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
      await this.auditLogService.record({
        actorType: AuditActorType.SYSTEM,
        action: 'session.reuse_detected',
        targetType: 'Session',
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
  }

  async listActiveSessions(
    principalType: SessionPrincipalType,
    principalId: string,
    filters: { createdFrom?: Date; createdTo?: Date } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<SessionSummary>> {
    const { page, limit } = pagination;
    const where: Prisma.SessionWhereInput = {
      principalType,
      principalId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
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
  }
}

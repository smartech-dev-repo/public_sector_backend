import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, AuditLog, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { auditRequestContext } from './audit-request-context';

export interface RecordAuditEventParams {
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Prisma.InputJsonValue;
  ip?: string;
  userAgent?: string;
}

export type AuditEntryKind = 'event' | 'request';

// The interceptor's baseline rows are named "METHOD /path (status)"; event names never contain " /".
const REQUEST_ACTION_MARKER = ' /';

export interface ListAuditEventsFilters {
  actorType?: AuditActorType;
  actorId?: string;
  action?: string;
  kind?: AuditEntryKind;
  targetType?: string;
  targetId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly principalResolver: PrincipalResolverService,
  ) {}

  async record(params: RecordAuditEventParams): Promise<void> {
    const origin = auditRequestContext.getStore();
    await this.prisma.auditLog.create({
      data: {
        actorType: params.actorType,
        actorId: params.actorId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        metadata: params.metadata,
        ip: params.ip ?? origin?.ip,
        userAgent: params.userAgent ?? origin?.userAgent,
      },
    });
  }

  /** For paths like sign-in, where a logging failure must never stop the user. */
  async recordSafely(params: RecordAuditEventParams): Promise<void> {
    try {
      await this.record(params);
    } catch (error) {
      this.logger.error(`Could not record audit event ${params.action}: ${error instanceof Error ? error.message : error}`);
    }
  }

  async list(
    filters: ListAuditEventsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AuditLog & { actor: Record<string, unknown> | null; target: Record<string, unknown> | null }>> {
    const { page, limit } = pagination;
    const where: Prisma.AuditLogWhereInput = {
      actorType: filters.actorType,
      actorId: filters.actorId,
      action: filters.action
        ? filters.action
        : filters.kind === 'request'
          ? { contains: REQUEST_ACTION_MARKER }
          : undefined,
      NOT: filters.kind === 'event' ? { action: { contains: REQUEST_ACTION_MARKER } } : undefined,
      targetType: filters.targetType,
      targetId: filters.targetId,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);

    const refs = [
      ...data.map((row) => ({ type: row.actorType as string, id: row.actorId })),
      ...data.map((row) => ({ type: row.targetType ?? '', id: row.targetId })),
    ];
    const resolved = await this.principalResolver.resolveMany(refs);

    const enriched = data.map((row) => ({
      ...row,
      actor: (row.actorId && resolved.get(`${row.actorType}:${row.actorId}`)) || null,
      target: (row.targetType && row.targetId && resolved.get(`${row.targetType}:${row.targetId}`)) || null,
    }));

    return buildPaginatedResult(enriched, total, page, limit);
  }
}

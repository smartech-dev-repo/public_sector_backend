import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, AuditLog, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { auditRequestContext } from './audit-request-context';
import { AuditAlertService } from './audit-alert.service';
import { NotificationService } from '../notifications/notification.service';
import { AuditOutcome, describeOutcome, outcomeWhere } from './audit-outcome';

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
  /** Matches who did it by name, email or phone. */
  actor?: string;
  outcome?: AuditOutcome;
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
    private readonly auditAlertService: AuditAlertService,
    private readonly notificationService: NotificationService,
  ) {}

  async record(params: RecordAuditEventParams): Promise<void> {
    const origin = auditRequestContext.getStore();
    // Set before the write: the automatic row is decided the moment the handler returns.
    if (origin && !params.action.includes(REQUEST_ACTION_MARKER)) {
      origin.namedEventRecorded = true;
    }
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
    void this.auditAlertService.evaluate({ ...params, ip: params.ip ?? origin?.ip });
    void this.notificationService.fromAuditEvent(params);
  }

  async wasRecordedRecently(action: string, actorId: string | undefined, targetId: string | undefined, minutes: number) {
    const recent = await this.prisma.auditLog.findFirst({
      where: { action, actorId, targetId, createdAt: { gte: new Date(Date.now() - minutes * 60000) } },
      select: { id: true },
    });
    return recent !== null;
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
  ): Promise<PaginatedResult<AuditLog & { actor: unknown; target: unknown; outcome: AuditOutcome; reason: string | null }>> {
    const { page, limit } = pagination;
    const where = await this.buildWhere(filters);

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);

    return buildPaginatedResult(await this.withPrincipals(data), total, page, limit);
  }

  /** The newest rows matching the filters, up to `maxRows`, plus how many matched in all. */
  async listForExport(filters: ListAuditEventsFilters, maxRows: number) {
    const where = await this.buildWhere(filters);
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: maxRows }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { rows: await this.withPrincipals(data), total };
  }

  private async buildWhere(filters: ListAuditEventsFilters): Promise<Prisma.AuditLogWhereInput> {
    const conditions: Prisma.AuditLogWhereInput[] = [];
    if (filters.outcome) {
      conditions.push(outcomeWhere(filters.outcome));
    }
    if (filters.actor) {
      const ids = await this.principalResolver.searchIds(filters.actor);
      conditions.push({ actorId: { in: [...ids.ADMIN, ...ids.AGENT, ...ids.CLIENT] } });
    }

    return {
      AND: conditions.length > 0 ? conditions : undefined,
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
  }

  private async withPrincipals(data: AuditLog[]) {
    const refs = [
      ...data.map((row) => ({ type: row.actorType as string, id: row.actorId })),
      ...data.map((row) => ({ type: row.targetType ?? '', id: row.targetId })),
    ];
    const resolved = await this.principalResolver.resolveMany(refs);

    return data.map((row) => ({
      ...row,
      ...describeOutcome(row.action, row.metadata),
      actor: (row.actorId && resolved.get(`${row.actorType}:${row.actorId}`)) || null,
      target: (row.targetType && row.targetId && resolved.get(`${row.targetType}:${row.targetId}`)) || null,
    }));
  }
}

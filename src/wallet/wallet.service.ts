import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AuditActorType,
  Prisma,
  WalletEntry,
  WalletEntryDirection,
  WalletEntrySource,
} from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { PrincipalResolverService } from '../common/principal-resolver.service';

export interface WalletActor {
  actorType: AuditActorType;
  actorId?: string;
}

/** Where a movement came from, and the record behind it. */
export interface WalletEntryOrigin {
  source?: WalletEntrySource;
  reference?: string | null;
}

export interface ListWalletEntriesFilters {
  direction?: WalletEntryDirection;
  actorType?: AuditActorType;
  source?: WalletEntrySource;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface ListWalletsFilters {
  /** The admin's client scope; undefined for every client. */
  scope?: Prisma.ClientWhereInput;
  /** Name, phone or staff ID. */
  search?: string;
  balance?: 'POSITIVE' | 'ZERO';
  sort?: 'balance' | 'recent' | 'credited' | 'debited';
}

type Pagination = { page: number; limit: number };

const round2 = (value: number) => Math.round(value * 100) / 100;
const signed = (entry: { amount: unknown; direction: WalletEntryDirection }) =>
  entry.direction === WalletEntryDirection.CREDIT ? Number(entry.amount) : -Number(entry.amount);

const CLIENT_SUMMARY_SELECT = {
  id: true,
  phone: true,
  status: true,
  onboarding: { select: { employeeName: true, agency: true, ippisRecord: { select: { staffId: true } } } },
} as const;

type ClientSummaryRow = Prisma.ClientGetPayload<{ select: typeof CLIENT_SUMMARY_SELECT }>;

const clientSummary = (client: ClientSummaryRow) => ({
  id: client.id,
  name: client.onboarding?.employeeName ?? null,
  phone: client.phone,
  status: client.status,
  agency: client.onboarding?.agency ?? null,
  staffId: client.onboarding?.ippisRecord?.staffId ?? null,
});

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalResolver: PrincipalResolverService,
  ) {}

  /**
   * One client's wallet: balance, lifetime totals, and a page of entries, each with the
   * balance right after it.
   */
  async getWallet(
    clientId: string,
    filters: ListWalletEntriesFilters = {},
    pagination: Pagination = { page: 1, limit: 25 },
  ): Promise<{
    balance: number;
    totals: { credited: number; debited: number; entries: number };
    entries: PaginatedResult<WalletEntry & { actor: Record<string, unknown> | null; balanceAfter: number }>;
  }> {
    await this.assertClientExists(clientId);

    const { page, limit } = pagination;
    const where: Prisma.WalletEntryWhereInput = { clientId, ...this.entryWhere(filters) };

    const [data, total, history] = await Promise.all([
      this.prisma.walletEntry.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletEntry.count({ where }),
      // Unfiltered: the balance after each entry must not depend on the filter.
      this.prisma.walletEntry.findMany({
        where: { clientId },
        select: { id: true, amount: true, direction: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    let running = 0;
    let credited = 0;
    let debited = 0;
    const balanceAfter = new Map<string, number>();
    for (const entry of history) {
      running += signed(entry);
      if (entry.direction === WalletEntryDirection.CREDIT) credited += Number(entry.amount);
      else debited += Number(entry.amount);
      balanceAfter.set(entry.id, round2(running));
    }

    const enriched = (await this.withActors(data)).map((row) => ({
      ...row,
      balanceAfter: balanceAfter.get(row.id) ?? 0,
    }));

    return {
      balance: round2(running),
      totals: { credited: round2(credited), debited: round2(debited), entries: history.length },
      entries: buildPaginatedResult(enriched, total, page, limit),
    };
  }

  // Unpaginated, unfiltered on purpose -- the real wallet balance must never
  // depend on which page of the entries list a caller happens to be viewing.
  async getBalance(clientId: string, db: Pick<PrismaService, 'walletEntry'> = this.prisma): Promise<number> {
    await this.assertClientExists(clientId);

    const entries = await db.walletEntry.findMany({
      where: { clientId },
      select: { amount: true, direction: true },
    });

    return round2(entries.reduce((sum, entry) => sum + signed(entry), 0));
  }

  async credit(
    clientId: string,
    amount: number,
    description: string,
    actor: WalletActor,
    origin: WalletEntryOrigin = {},
  ): Promise<WalletEntry> {
    await this.assertClientExists(clientId);

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.CREDIT,
        description,
        source: origin.source ?? WalletEntrySource.MANUAL,
        reference: origin.reference ?? null,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  /** Refuses to take the balance below zero. Debits on one wallet run one at a time. */
  async debit(
    clientId: string,
    amount: number,
    description: string,
    actor: WalletActor,
    origin: WalletEntryOrigin = {},
  ): Promise<WalletEntry> {
    await this.assertClientExists(clientId);

    return this.prisma.$transaction(async (tx) => {
      // Two debits checked at once could both see enough balance; the lock makes them queue.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet:${clientId}`}))`;
      const balance = await this.getBalance(clientId, tx);

      if (amount > balance + 0.005) {
        throw new UnprocessableEntityException('Insufficient wallet balance');
      }

      return tx.walletEntry.create({
        data: {
          clientId,
          amount,
          direction: WalletEntryDirection.DEBIT,
          description,
          source: origin.source ?? WalletEntrySource.MANUAL,
          reference: origin.reference ?? null,
          actorType: actor.actorType,
          actorId: actor.actorId,
        },
      });
    });
  }

  /**
   * Every wallet that has had a movement, with its balance and totals. Sorted and paged in
   * memory: balances are sums, which the database can't sort on through Prisma.
   */
  async listWallets(filters: ListWalletsFilters, pagination: Pagination) {
    const { page, limit } = pagination;
    const clientWhere = this.clientWhere(filters.scope, filters.search);
    const clients = await this.prisma.client.findMany({
      where: { AND: [clientWhere, { walletEntries: { some: {} } }] },
      select: { id: true },
    });
    const stats = await this.walletStats(clients.map((c) => c.id));

    let rows = [...stats.values()];
    if (filters.balance === 'POSITIVE') rows = rows.filter((r) => r.balance > 0.005);
    if (filters.balance === 'ZERO') rows = rows.filter((r) => Math.abs(r.balance) <= 0.005);
    const sorters: Record<NonNullable<ListWalletsFilters['sort']>, (a: WalletStats, b: WalletStats) => number> = {
      balance: (a, b) => b.balance - a.balance,
      credited: (a, b) => b.credited - a.credited,
      debited: (a, b) => b.debited - a.debited,
      recent: (a, b) => b.lastEntryAt.getTime() - a.lastEntryAt.getTime(),
    };
    rows.sort((a, b) => sorters[filters.sort ?? 'balance'](a, b) || b.lastEntryAt.getTime() - a.lastEntryAt.getTime());

    const pageRows = rows.slice((page - 1) * limit, page * limit);
    const details = await this.prisma.client.findMany({
      where: { id: { in: pageRows.map((r) => r.clientId) } },
      select: CLIENT_SUMMARY_SELECT,
    });
    const byId = new Map(details.map((c) => [c.id, clientSummary(c)]));
    const data = pageRows.map((r) => ({ client: byId.get(r.clientId) ?? null, ...r }));
    return buildPaginatedResult(data, rows.length, page, limit);
  }

  /**
   * Money held across wallets now, and what moved in a period (this month by default),
   * by direction and source.
   */
  async summary(scope: Prisma.ClientWhereInput | undefined, period: { from?: Date; to?: Date } = {}) {
    const now = new Date();
    const from = period.from ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const to = period.to ?? now;

    const clients = await this.prisma.client.findMany({
      where: { AND: [scope ?? {}, { walletEntries: { some: {} } }] },
      select: { id: true },
    });
    const stats = [...(await this.walletStats(clients.map((c) => c.id))).values()];

    const moved = await this.prisma.walletEntry.groupBy({
      by: ['direction', 'source'],
      where: { createdAt: { gte: from, lte: to }, ...(scope ? { client: scope } : {}) },
      _sum: { amount: true },
      _count: { _all: true },
    });
    const bySource = Object.fromEntries(
      Object.values(WalletEntrySource).map((source) => [source, { credited: 0, debited: 0, count: 0 }]),
    ) as Record<WalletEntrySource, { credited: number; debited: number; count: number }>;
    let credited = 0;
    let debited = 0;
    for (const row of moved) {
      const amount = Number(row._sum.amount ?? 0);
      const bucket = bySource[row.source];
      bucket.count += row._count._all;
      if (row.direction === WalletEntryDirection.CREDIT) {
        bucket.credited = round2(bucket.credited + amount);
        credited += amount;
      } else {
        bucket.debited = round2(bucket.debited + amount);
        debited += amount;
      }
    }

    return {
      totalHeld: round2(stats.reduce((sum, s) => sum + Math.max(0, s.balance), 0)),
      walletsWithBalance: stats.filter((s) => s.balance > 0.005).length,
      wallets: stats.length,
      period: {
        from: from.toISOString(),
        to: to.toISOString(),
        credited: round2(credited),
        debited: round2(debited),
        net: round2(credited - debited),
        bySource,
      },
    };
  }

  /** Movements across every wallet in scope, newest first, with the client and who did it. */
  async listEntries(
    filters: ListWalletEntriesFilters & { scope?: Prisma.ClientWhereInput; search?: string },
    pagination: Pagination,
  ) {
    const { page, limit } = pagination;
    const clientWhere = this.clientWhere(filters.scope, filters.search);
    const where: Prisma.WalletEntryWhereInput = {
      ...this.entryWhere(filters),
      ...(Object.keys(clientWhere).length ? { client: clientWhere } : {}),
    };

    const [data, total, sums] = await Promise.all([
      this.prisma.walletEntry.findMany({
        where,
        include: { client: { select: CLIENT_SUMMARY_SELECT } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletEntry.count({ where }),
      this.prisma.walletEntry.groupBy({ by: ['direction'], where, _sum: { amount: true } }),
    ]);

    const sumOf = (direction: WalletEntryDirection) =>
      round2(Number(sums.find((s) => s.direction === direction)?._sum.amount ?? 0));
    const rows = (await this.withActors(data)).map(({ client, ...row }) => ({ ...row, client: clientSummary(client) }));
    return {
      ...buildPaginatedResult(rows, total, page, limit),
      totals: { credited: sumOf(WalletEntryDirection.CREDIT), debited: sumOf(WalletEntryDirection.DEBIT) },
    };
  }

  /** Ids of the clients an admin can see, for counting requests on them. */
  async clientIdsInScope(scope: Prisma.ClientWhereInput): Promise<string[]> {
    const rows = await this.prisma.client.findMany({ where: scope, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private entryWhere(filters: ListWalletEntriesFilters): Prisma.WalletEntryWhereInput {
    return {
      direction: filters.direction,
      actorType: filters.actorType,
      source: filters.source,
      createdAt:
        filters.createdFrom || filters.createdTo ? { gte: filters.createdFrom, lte: filters.createdTo } : undefined,
    };
  }

  private clientWhere(scope: Prisma.ClientWhereInput | undefined, search?: string): Prisma.ClientWhereInput {
    const term = search?.trim();
    const conditions: Prisma.ClientWhereInput[] = [];
    if (scope) conditions.push(scope);
    if (term) {
      conditions.push({
        OR: [
          { phone: { contains: term } },
          { onboarding: { employeeName: { contains: term, mode: 'insensitive' } } },
          { onboarding: { ippisRecord: { staffId: { contains: term, mode: 'insensitive' } } } },
        ],
      });
    }
    return conditions.length ? { AND: conditions } : {};
  }

  private async walletStats(clientIds: string[]): Promise<Map<string, WalletStats>> {
    const stats = new Map<string, WalletStats>();
    if (clientIds.length === 0) return stats;
    const groups = await this.prisma.walletEntry.groupBy({
      by: ['clientId', 'direction'],
      where: { clientId: { in: clientIds } },
      _sum: { amount: true },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    for (const group of groups) {
      const row = stats.get(group.clientId) ?? {
        clientId: group.clientId,
        balance: 0,
        credited: 0,
        debited: 0,
        entries: 0,
        lastEntryAt: new Date(0),
      };
      const amount = Number(group._sum.amount ?? 0);
      if (group.direction === WalletEntryDirection.CREDIT) row.credited = round2(row.credited + amount);
      else row.debited = round2(row.debited + amount);
      row.balance = round2(row.credited - row.debited);
      row.entries += group._count._all;
      if (group._max.createdAt && group._max.createdAt > row.lastEntryAt) row.lastEntryAt = group._max.createdAt;
      stats.set(group.clientId, row);
    }
    return stats;
  }

  private async withActors<T extends { actorType: AuditActorType; actorId: string | null }>(rows: T[]) {
    const resolved = await this.principalResolver.resolveMany(
      rows.map((row) => ({ type: row.actorType as string, id: row.actorId })),
    );
    return rows.map((row) => ({
      ...row,
      actor: (row.actorId && resolved.get(`${row.actorType}:${row.actorId}`)) || null,
    }));
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
  }
}

interface WalletStats {
  clientId: string;
  balance: number;
  credited: number;
  debited: number;
  entries: number;
  lastEntryAt: Date;
}

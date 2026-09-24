import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, Prisma, WalletEntry, WalletEntryDirection } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { PrincipalResolverService } from '../common/principal-resolver.service';

export interface WalletActor {
  actorType: AuditActorType;
  actorId?: string;
}

export interface ListWalletEntriesFilters {
  direction?: WalletEntryDirection;
  actorType?: AuditActorType;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly principalResolver: PrincipalResolverService,
  ) {}

  async getWallet(
    clientId: string,
    filters: ListWalletEntriesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<{ balance: number; entries: PaginatedResult<WalletEntry & { actor: Record<string, unknown> | null }> }> {
    await this.assertClientExists(clientId);

    const { page, limit } = pagination;
    const where: Prisma.WalletEntryWhereInput = {
      clientId,
      direction: filters.direction,
      actorType: filters.actorType,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total, balance] = await Promise.all([
      this.prisma.walletEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.walletEntry.count({ where }),
      this.getBalance(clientId),
    ]);

    const resolved = await this.principalResolver.resolveMany(
      data.map((row) => ({ type: row.actorType as string, id: row.actorId })),
    );
    const enriched = data.map((row) => ({
      ...row,
      actor: (row.actorId && resolved.get(`${row.actorType}:${row.actorId}`)) || null,
    }));

    return { balance, entries: buildPaginatedResult(enriched, total, page, limit) };
  }

  // Unpaginated, unfiltered on purpose -- the real wallet balance must never
  // depend on which page of the entries list a caller happens to be viewing.
  async getBalance(clientId: string): Promise<number> {
    await this.assertClientExists(clientId);

    const entries = await this.prisma.walletEntry.findMany({
      where: { clientId },
      select: { amount: true, direction: true },
    });

    return this.sumEntries(entries);
  }

  async credit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    await this.assertClientExists(clientId);

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.CREDIT,
        description,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  async debit(clientId: string, amount: number, description: string, actor: WalletActor): Promise<WalletEntry> {
    const balance = await this.getBalance(clientId);

    if (amount > balance) {
      throw new UnprocessableEntityException('Insufficient wallet balance');
    }

    return this.prisma.walletEntry.create({
      data: {
        clientId,
        amount,
        direction: WalletEntryDirection.DEBIT,
        description,
        actorType: actor.actorType,
        actorId: actor.actorId,
      },
    });
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
  }

  private sumEntries(entries: Array<{ amount: unknown; direction: WalletEntryDirection }>): number {
    return entries.reduce((total, entry) => {
      const amount = Number(entry.amount);
      return total + (entry.direction === WalletEntryDirection.CREDIT ? amount : -amount);
    }, 0);
  }
}

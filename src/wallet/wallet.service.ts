import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, WalletEntry, WalletEntryDirection } from '../generated/prisma/client';

export interface WalletActor {
  actorType: AuditActorType;
  actorId?: string;
}

@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  async getWallet(clientId: string): Promise<{ balance: number; entries: WalletEntry[] }> {
    await this.assertClientExists(clientId);

    const entries = await this.prisma.walletEntry.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });

    return { balance: this.sumEntries(entries), entries };
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
    const { balance } = await this.getWallet(clientId);

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

import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, WalletEntryDirection } from '../generated/prisma/client';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    client: { findUnique: jest.Mock };
    walletEntry: { findMany: jest.Mock; create: jest.Mock };
  };

  const adminActor = { actorType: AuditActorType.ADMIN, actorId: 'admin-1' };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      walletEntry: { findMany: jest.fn(), create: jest.fn() },
    };
    service = new WalletService(prisma as unknown as PrismaService);
  });

  describe('getWallet', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns a zero balance and empty entries for a client with no history', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);

      const result = await service.getWallet('client-1');

      expect(result).toEqual({ balance: 0, entries: [] });
    });

    it('sums credits and subtracts debits to compute the balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ]);

      const result = await service.getWallet('client-1');

      expect(result.balance).toBe(3700);
    });
  });

  describe('credit', () => {
    it('creates a CREDIT entry with the given actor', async () => {
      prisma.walletEntry.create.mockResolvedValue({ id: 'entry-1' });

      await service.credit('client-1', 5000, 'Goodwill credit', adminActor);

      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: {
          clientId: 'client-1',
          amount: 5000,
          direction: WalletEntryDirection.CREDIT,
          description: 'Goodwill credit',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
        },
      });
    });

    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.credit('missing', 5000, 'x', adminActor)).rejects.toThrow(NotFoundException);
      expect(prisma.walletEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('debit', () => {
    it('creates a DEBIT entry when the amount is within the current balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 5000, direction: WalletEntryDirection.CREDIT }]);
      prisma.walletEntry.create.mockResolvedValue({ id: 'entry-2' });

      await service.debit('client-1', 3000, 'Excess deduction', adminActor);

      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: {
          clientId: 'client-1',
          amount: 3000,
          direction: WalletEntryDirection.DEBIT,
          description: 'Excess deduction',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
        },
      });
    });

    it('rejects a debit that would take the balance below zero, without writing an entry', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 1000, direction: WalletEntryDirection.CREDIT }]);

      await expect(service.debit('client-1', 1500, 'Too much', adminActor)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.walletEntry.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.debit('missing', 100, 'x', adminActor)).rejects.toThrow(NotFoundException);
    });
  });
});

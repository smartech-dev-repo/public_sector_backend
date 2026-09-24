import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { AuditActorType, WalletEntryDirection } from '../generated/prisma/client';

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    client: { findUnique: jest.Mock };
    walletEntry: { findMany: jest.Mock; create: jest.Mock; count: jest.Mock };
  };
  let principalResolver: { resolveMany: jest.Mock };

  const adminActor = { actorType: AuditActorType.ADMIN, actorId: 'admin-1' };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn().mockResolvedValue({ id: 'client-1' }) },
      walletEntry: { findMany: jest.fn(), create: jest.fn(), count: jest.fn() },
    };
    principalResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    service = new WalletService(prisma as unknown as PrismaService, principalResolver as unknown as PrincipalResolverService);
  });

  describe('getWallet', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns a zero balance and an empty paginated entries list for a client with no history', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);
      prisma.walletEntry.count.mockResolvedValue(0);

      const result = await service.getWallet('client-1');

      expect(result).toEqual({ balance: 0, entries: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } } });
    });

    it('sums credits and subtracts debits to compute the balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ]);
      prisma.walletEntry.count.mockResolvedValue(3);

      const result = await service.getWallet('client-1');

      expect(result.balance).toBe(3700);
    });

    it('filters entries by direction/actorType and applies a createdAt range', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);
      prisma.walletEntry.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.getWallet('client-1', {
        direction: WalletEntryDirection.CREDIT,
        actorType: AuditActorType.ADMIN,
        createdFrom,
        createdTo,
      });

      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            direction: WalletEntryDirection.CREDIT,
            actorType: AuditActorType.ADMIN,
            createdAt: { gte: createdFrom, lte: createdTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit for the entries list', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([]);
      prisma.walletEntry.count.mockResolvedValue(30);

      const result = await service.getWallet('client-1', {}, { page: 2, limit: 10 });

      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
      expect(result.entries.meta).toEqual({ total: 30, page: 2, limit: 10, totalPages: 3 });
    });

    it('computes the balance from every entry, independent of the entries page size', async () => {
      const allEntries = [
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
        { amount: 200, direction: WalletEntryDirection.CREDIT },
      ];
      prisma.walletEntry.count.mockResolvedValue(3);
      prisma.walletEntry.findMany.mockImplementation((args: { take?: number }) =>
        Promise.resolve(args.take ? allEntries.slice(0, args.take) : allEntries),
      );

      const result = await service.getWallet('client-1', {}, { page: 1, limit: 1 });

      expect(result.entries.data).toHaveLength(1);
      expect(result.balance).toBe(3700);
    });

    it('attaches a resolved actor object to each entry', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { id: 'entry-1', amount: 5000, direction: WalletEntryDirection.CREDIT, actorType: AuditActorType.ADMIN, actorId: 'admin-1' },
      ]);
      prisma.walletEntry.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(
        new Map<string, unknown>([['ADMIN:admin-1', { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }]]),
      );

      const result = await service.getWallet('client-1');

      expect(principalResolver.resolveMany).toHaveBeenCalledWith([{ type: AuditActorType.ADMIN, id: 'admin-1' }]);
      expect(result.entries.data[0].actor).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });
  });

  describe('getBalance', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getBalance('missing')).rejects.toThrow(NotFoundException);
    });

    it('sums credits and subtracts debits', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: WalletEntryDirection.CREDIT },
        { amount: 1500, direction: WalletEntryDirection.DEBIT },
      ]);

      const balance = await service.getBalance('client-1');

      expect(balance).toBe(3500);
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

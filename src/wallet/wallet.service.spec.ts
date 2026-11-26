import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { AuditActorType, WalletEntryDirection, WalletEntrySource } from '../generated/prisma/client';

const CREDIT = WalletEntryDirection.CREDIT;
const DEBIT = WalletEntryDirection.DEBIT;

describe('WalletService', () => {
  let service: WalletService;
  let prisma: {
    client: { findUnique: jest.Mock; findMany: jest.Mock };
    walletEntry: { findMany: jest.Mock; create: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
    $transaction: jest.Mock;
    $executeRaw: jest.Mock;
  };
  let principalResolver: { resolveMany: jest.Mock };

  const adminActor = { actorType: AuditActorType.ADMIN, actorId: 'admin-1' };

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn().mockResolvedValue({ id: 'client-1' }), findMany: jest.fn().mockResolvedValue([]) },
      walletEntry: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    // The transaction client is the same mock, so writes inside it are visible to the test.
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    principalResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    service = new WalletService(prisma as unknown as PrismaService, principalResolver as unknown as PrincipalResolverService);
  });

  describe('getWallet', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getWallet('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns a zero balance, zero totals and an empty page for a client with no history', async () => {
      const result = await service.getWallet('client-1');

      expect(result).toEqual({
        balance: 0,
        totals: { credited: 0, debited: 0, entries: 0 },
        entries: { data: [], meta: { total: 0, page: 1, limit: 25, totalPages: 0 } },
      });
    });

    it('computes the balance and totals from every entry, and the balance after each entry on the page', async () => {
      const history = [
        { id: 'e1', amount: 5000, direction: CREDIT },
        { id: 'e2', amount: 1500, direction: DEBIT },
        { id: 'e3', amount: 200, direction: CREDIT },
      ];
      // The page is newest first and holds only one entry; the history is oldest first.
      prisma.walletEntry.findMany.mockImplementation((args: { take?: number }) =>
        Promise.resolve(args.take ? [{ ...history[1], actorType: 'ADMIN', actorId: null }] : history),
      );
      prisma.walletEntry.count.mockResolvedValue(3);

      const result = await service.getWallet('client-1', {}, { page: 2, limit: 1 });

      expect(result.balance).toBe(3700);
      expect(result.totals).toEqual({ credited: 5200, debited: 1500, entries: 3 });
      expect(result.entries.data).toHaveLength(1);
      expect(result.entries.data[0].balanceAfter).toBe(3500);
      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 1, take: 1 }));
    });

    it('filters entries by direction, actor, source and a createdAt range, but not the history', async () => {
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.getWallet('client-1', {
        direction: CREDIT,
        actorType: AuditActorType.ADMIN,
        source: WalletEntrySource.MANUAL,
        createdFrom,
        createdTo,
      });

      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            clientId: 'client-1',
            direction: CREDIT,
            actorType: AuditActorType.ADMIN,
            source: WalletEntrySource.MANUAL,
            createdAt: { gte: createdFrom, lte: createdTo },
          },
        }),
      );
      expect(prisma.walletEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'client-1' } }));
    });

    it('attaches a resolved actor object to each entry', async () => {
      prisma.walletEntry.findMany.mockImplementation((args: { take?: number }) =>
        Promise.resolve(
          args.take
            ? [{ id: 'entry-1', amount: 5000, direction: CREDIT, actorType: AuditActorType.ADMIN, actorId: 'admin-1' }]
            : [{ id: 'entry-1', amount: 5000, direction: CREDIT }],
        ),
      );
      prisma.walletEntry.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(
        new Map<string, unknown>([['ADMIN:admin-1', { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }]]),
      );

      const result = await service.getWallet('client-1');

      expect(principalResolver.resolveMany).toHaveBeenCalledWith([{ type: AuditActorType.ADMIN, id: 'admin-1' }]);
      expect(result.entries.data[0].actor).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
      expect(result.entries.data[0].balanceAfter).toBe(5000);
    });
  });

  describe('getBalance', () => {
    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.getBalance('missing')).rejects.toThrow(NotFoundException);
    });

    it('sums credits and subtracts debits', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        { amount: 5000, direction: CREDIT },
        { amount: 1500, direction: DEBIT },
      ]);

      expect(await service.getBalance('client-1')).toBe(3500);
    });
  });

  describe('credit', () => {
    it('creates a MANUAL CREDIT entry by default', async () => {
      prisma.walletEntry.create.mockResolvedValue({ id: 'entry-1' });

      await service.credit('client-1', 5000, 'Goodwill credit', adminActor);

      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: {
          clientId: 'client-1',
          amount: 5000,
          direction: CREDIT,
          description: 'Goodwill credit',
          source: WalletEntrySource.MANUAL,
          reference: null,
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
        },
      });
    });

    it('keeps the source and the record behind it', async () => {
      await service.credit('client-1', 700, 'Loan overpayment excess', { actorType: AuditActorType.SYSTEM }, {
        source: WalletEntrySource.LOAN_OVERPAYMENT,
        reference: 'loan-1',
      });

      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ source: WalletEntrySource.LOAN_OVERPAYMENT, reference: 'loan-1' }),
      });
    });

    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.credit('missing', 5000, 'x', adminActor)).rejects.toThrow(NotFoundException);
      expect(prisma.walletEntry.create).not.toHaveBeenCalled();
    });
  });

  describe('debit', () => {
    it('locks the wallet, then creates a DEBIT entry when the amount is within the balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 5000, direction: CREDIT }]);
      prisma.walletEntry.create.mockResolvedValue({ id: 'entry-2' });

      await service.debit('client-1', 3000, 'Excess deduction', adminActor, { reference: 'approval-1' });

      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(prisma.walletEntry.findMany.mock.invocationCallOrder[0]);
      expect(prisma.walletEntry.create).toHaveBeenCalledWith({
        data: {
          clientId: 'client-1',
          amount: 3000,
          direction: DEBIT,
          description: 'Excess deduction',
          source: WalletEntrySource.MANUAL,
          reference: 'approval-1',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
        },
      });
    });

    it('allows debiting the whole balance', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 1000.1, direction: CREDIT }]);

      await service.debit('client-1', 1000.1, 'All of it', adminActor);

      expect(prisma.walletEntry.create).toHaveBeenCalled();
    });

    it('rejects a debit that would take the balance below zero, without writing an entry', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([{ amount: 1000, direction: CREDIT }]);

      await expect(service.debit('client-1', 1500, 'Too much', adminActor)).rejects.toThrow(UnprocessableEntityException);
      expect(prisma.walletEntry.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the client does not exist', async () => {
      prisma.client.findUnique.mockResolvedValue(null);

      await expect(service.debit('missing', 100, 'x', adminActor)).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('listWallets', () => {
    const at = (day: number) => new Date(`2026-11-${String(day).padStart(2, '0')}T10:00:00Z`);
    const group = (clientId: string, direction: WalletEntryDirection, amount: number, count: number, day: number) => ({
      clientId,
      direction,
      _sum: { amount },
      _count: { _all: count },
      _max: { createdAt: at(day) },
    });

    beforeEach(() => {
      prisma.client.findMany.mockImplementation((args: { where: { id?: unknown } }) =>
        Promise.resolve(
          args.where.id
            ? [
                { id: 'a', phone: '+2348000000001', status: 'APPROVED', onboarding: { employeeName: 'Ada', agency: 'NPF', ippisRecord: { staffId: 'PF1' } } },
                { id: 'b', phone: '+2348000000002', status: 'APPROVED', onboarding: null },
              ]
            : [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        ),
      );
      prisma.walletEntry.groupBy.mockResolvedValue([
        group('a', CREDIT, 10000, 2, 3),
        group('a', DEBIT, 4000, 1, 5),
        group('b', CREDIT, 2000, 1, 9),
        group('c', CREDIT, 500, 1, 1),
        group('c', DEBIT, 500, 1, 2),
      ]);
    });

    it('lists wallets with balance and totals, highest balance first, with the client', async () => {
      const result = await service.listWallets({}, { page: 1, limit: 2 });

      expect(result.meta).toEqual({ total: 3, page: 1, limit: 2, totalPages: 2 });
      expect(result.data[0]).toEqual({
        client: { id: 'a', name: 'Ada', phone: '+2348000000001', status: 'APPROVED', agency: 'NPF', staffId: 'PF1' },
        clientId: 'a',
        balance: 6000,
        credited: 10000,
        debited: 4000,
        entries: 3,
        lastEntryAt: at(5),
      });
      expect(result.data[1]).toMatchObject({ clientId: 'b', balance: 2000, client: { name: null, staffId: null } });
    });

    it('filters to wallets with money or empty ones, and sorts by most recent', async () => {
      const withMoney = await service.listWallets({ balance: 'POSITIVE', sort: 'recent' }, { page: 1, limit: 10 });
      expect(withMoney.data.map((r) => r.clientId)).toEqual(['b', 'a']);

      const empty = await service.listWallets({ balance: 'ZERO' }, { page: 1, limit: 10 });
      expect(empty.data.map((r) => r.clientId)).toEqual(['c']);
    });

    it('searches clients in the admin scope by name, phone or staff ID', async () => {
      await service.listWallets({ scope: { assignedAdminId: 'admin-1' }, search: ' pf1 ' }, { page: 1, limit: 10 });

      expect(prisma.client.findMany).toHaveBeenCalledWith({
        where: {
          AND: [
            {
              AND: [
                { assignedAdminId: 'admin-1' },
                {
                  OR: [
                    { phone: { contains: 'pf1' } },
                    { onboarding: { employeeName: { contains: 'pf1', mode: 'insensitive' } } },
                    { onboarding: { ippisRecord: { staffId: { contains: 'pf1', mode: 'insensitive' } } } },
                  ],
                },
              ],
            },
            { walletEntries: { some: {} } },
          ],
        },
        select: { id: true },
      });
    });
  });

  describe('summary', () => {
    it('totals money held now and what moved in the period, by source', async () => {
      prisma.client.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      prisma.walletEntry.groupBy.mockImplementation((args: { by: string[] }) =>
        Promise.resolve(
          args.by.includes('clientId')
            ? [
                { clientId: 'a', direction: CREDIT, _sum: { amount: 9000 }, _count: { _all: 2 }, _max: { createdAt: new Date() } },
                { clientId: 'a', direction: DEBIT, _sum: { amount: 1000 }, _count: { _all: 1 }, _max: { createdAt: new Date() } },
                { clientId: 'b', direction: CREDIT, _sum: { amount: 300 }, _count: { _all: 1 }, _max: { createdAt: new Date() } },
                { clientId: 'b', direction: DEBIT, _sum: { amount: 300 }, _count: { _all: 1 }, _max: { createdAt: new Date() } },
              ]
            : [
                { direction: CREDIT, source: WalletEntrySource.LOAN_OVERPAYMENT, _sum: { amount: 4000 }, _count: { _all: 2 } },
                { direction: CREDIT, source: WalletEntrySource.MANUAL, _sum: { amount: 500 }, _count: { _all: 1 } },
                { direction: DEBIT, source: WalletEntrySource.LOAN_REPAYMENT, _sum: { amount: 1000 }, _count: { _all: 1 } },
              ],
        ),
      );
      const from = new Date('2026-11-01T00:00:00Z');
      const to = new Date('2026-11-30T23:59:59Z');

      const summary = await service.summary(undefined, { from, to });

      expect(summary).toMatchObject({
        totalHeld: 8000,
        walletsWithBalance: 1,
        wallets: 2,
        period: { from: from.toISOString(), to: to.toISOString(), credited: 4500, debited: 1000, net: 3500 },
      });
      expect(summary.period.bySource).toEqual({
        MANUAL: { credited: 500, debited: 0, count: 1 },
        LOAN_OVERPAYMENT: { credited: 4000, debited: 0, count: 2 },
        DEDUCTION_REFUND: { credited: 0, debited: 0, count: 0 },
        LOAN_REPAYMENT: { credited: 0, debited: 1000, count: 1 },
      });
      expect(prisma.walletEntry.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['direction', 'source'], where: { createdAt: { gte: from, lte: to } } }),
      );
    });
  });

  describe('listEntries', () => {
    it('lists movements across wallets with the client and totals for the filter', async () => {
      prisma.walletEntry.findMany.mockResolvedValue([
        {
          id: 'e1',
          amount: 2500,
          direction: CREDIT,
          source: WalletEntrySource.DEDUCTION_REFUND,
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
          client: { id: 'a', phone: '+2348000000001', status: 'APPROVED', onboarding: { employeeName: 'Ada', agency: 'NPF', ippisRecord: { staffId: 'PF1' } } },
        },
      ]);
      prisma.walletEntry.count.mockResolvedValue(1);
      prisma.walletEntry.groupBy.mockResolvedValue([{ direction: CREDIT, _sum: { amount: 2500 } }]);

      const result = await service.listEntries(
        { scope: { assignedAdminId: 'admin-1' }, source: WalletEntrySource.DEDUCTION_REFUND },
        { page: 1, limit: 25 },
      );

      expect(result.totals).toEqual({ credited: 2500, debited: 0 });
      expect(result.data[0].client).toEqual({ id: 'a', name: 'Ada', phone: '+2348000000001', status: 'APPROVED', agency: 'NPF', staffId: 'PF1' });
      expect(prisma.walletEntry.count).toHaveBeenCalledWith({
        where: expect.objectContaining({
          source: WalletEntrySource.DEDUCTION_REFUND,
          client: { AND: [{ assignedAdminId: 'admin-1' }] },
        }),
      });
    });
  });
});

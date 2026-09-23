import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AdminInviteService } from './admin-invite.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken } from '../common/opaque-token.util';
import { AdminInviteStatus } from '../generated/prisma/client';

describe('AdminInviteService', () => {
  let service: AdminInviteService;
  let prisma: {
    adminInvite: {
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      adminInvite: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
      },
    };
    service = new AdminInviteService(prisma as unknown as PrismaService);
  });

  it('creates an invite with a hashed token and a 7-day expiry', async () => {
    prisma.adminInvite.create.mockResolvedValue({ id: 'invite-1' });

    const { token } = await service.create({
      email: 'new-admin@example.com',
      roleId: 'role-1',
      invitedById: 'admin-1',
    });

    const createArgs = prisma.adminInvite.create.mock.calls[0][0];
    expect(createArgs.data.email).toBe('new-admin@example.com');
    expect(createArgs.data.roleId).toBe('role-1');
    expect(createArgs.data.invitedById).toBe('admin-1');
    expect(createArgs.data.tokenHash).toBe(hashToken(token));
    const expiresInMs = createArgs.data.expiresAt.getTime() - Date.now();
    expect(expiresInMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(expiresInMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it('resend rejects an invite that is not PENDING', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({ id: 'invite-1', status: AdminInviteStatus.ACCEPTED });
    await expect(service.resend('invite-1')).rejects.toThrow(NotFoundException);
  });

  it('resend reissues a new token for a PENDING invite', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({ id: 'invite-1', status: AdminInviteStatus.PENDING });
    prisma.adminInvite.update.mockResolvedValue({ id: 'invite-1', email: 'new-admin@example.com' });

    const { token } = await service.resend('invite-1');

    const updateArgs = prisma.adminInvite.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'invite-1' });
    expect(updateArgs.data.tokenHash).toBe(hashToken(token));
  });

  it('findValidByToken rejects an unknown token', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue(null);
    await expect(service.findValidByToken('unknown')).rejects.toThrow(UnauthorizedException);
  });

  it('findValidByToken rejects an expired invite', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({
      status: AdminInviteStatus.PENDING,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.findValidByToken('expired')).rejects.toThrow(UnauthorizedException);
  });

  it('findValidByToken rejects an already-accepted invite', async () => {
    prisma.adminInvite.findUnique.mockResolvedValue({
      status: AdminInviteStatus.ACCEPTED,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(service.findValidByToken('used')).rejects.toThrow(UnauthorizedException);
  });

  it('findValidByToken returns the invite when valid', async () => {
    const invite = { status: AdminInviteStatus.PENDING, expiresAt: new Date(Date.now() + 60_000) };
    prisma.adminInvite.findUnique.mockResolvedValue(invite);
    expect(await service.findValidByToken('valid')).toBe(invite);
  });

  it('markAccepted sets status ACCEPTED and acceptedAt', async () => {
    await service.markAccepted('invite-1');
    expect(prisma.adminInvite.update).toHaveBeenCalledWith({
      where: { id: 'invite-1' },
      data: { status: AdminInviteStatus.ACCEPTED, acceptedAt: expect.any(Date) },
    });
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches email', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(0);

      await service.list({ status: AdminInviteStatus.PENDING, q: 'someone@example.com' });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: AdminInviteStatus.PENDING,
            email: { contains: 'someone@example.com', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('applies createdAt and expiresAt date ranges independently', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const expiresTo = new Date('2025-06-01');

      await service.list({ createdFrom, expiresTo });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: createdFrom, lte: undefined },
            expiresAt: { gte: undefined, lte: expiresTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.adminInvite.findMany.mockResolvedValue([]);
      prisma.adminInvite.count.mockResolvedValue(6);

      const result = await service.list({}, { page: 2, limit: 3 });

      expect(prisma.adminInvite.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
      expect(result.meta).toEqual({ total: 6, page: 2, limit: 3, totalPages: 2 });
    });
  });
});

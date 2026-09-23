import { UnauthorizedException, NotFoundException } from '@nestjs/common';
import { SessionService } from './session.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SessionPrincipalType } from '../generated/prisma/client';

describe('SessionService', () => {
  let service: SessionService;
  let prisma: {
    session: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let auditLogService: { record: jest.Mock };

  beforeEach(() => {
    prisma = {
      session: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    auditLogService = { record: jest.fn() };
    service = new SessionService(
      prisma as unknown as PrismaService,
      auditLogService as unknown as AuditLogService,
    );
  });

  it('creates a session and returns a plaintext token not stored anywhere', async () => {
    prisma.session.create.mockResolvedValue({});

    const token = await service.createSession({
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(32);
    const createArgs = prisma.session.create.mock.calls[0][0];
    expect(createArgs.data.principalType).toBe(SessionPrincipalType.CLIENT);
    expect(createArgs.data.principalId).toBe('client-1');
    expect(createArgs.data.refreshTokenHash).not.toEqual(token);
  });

  it('rejects rotating an unknown token', async () => {
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.rotate('unknown-token')).rejects.toThrow(UnauthorizedException);
  });

  it('rotates a valid token: revokes the old session and issues a new one', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.AGENT,
      principalId: 'agent-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.update.mockResolvedValue({});
    prisma.session.create.mockResolvedValue({});

    const result = await service.rotate('valid-token');

    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { revokedAt: expect.any(Date), revokedReason: 'rotated' },
    });
    expect(result.principalType).toBe(SessionPrincipalType.AGENT);
    expect(result.principalId).toBe('agent-1');
    expect(typeof result.refreshToken).toBe('string');
  });

  it('treats presenting an already-revoked token as reuse: revokes every session for that principal', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 2 });

    await expect(service.rotate('stolen-token')).rejects.toThrow(UnauthorizedException);

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { principalType: SessionPrincipalType.CLIENT, principalId: 'client-1', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedReason: 'reuse_detected' },
    });
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session.reuse_detected' }),
    );
  });

  it('rejects rotating an expired token and revokes it', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'client-1',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });
    prisma.session.update.mockResolvedValue({});

    await expect(service.rotate('expired-token')).rejects.toThrow(UnauthorizedException);
    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 'session-1' },
      data: { revokedAt: expect.any(Date), revokedReason: 'expired' },
    });
  });

  it('revokeByToken is idempotent for an unknown token', async () => {
    prisma.session.findUnique.mockResolvedValue(null);
    await expect(service.revokeByToken('unknown')).resolves.toBeUndefined();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('revokeOwnSession throws NotFoundException for a session belonging to someone else', async () => {
    prisma.session.findUnique.mockResolvedValue({
      id: 'session-1',
      principalType: SessionPrincipalType.CLIENT,
      principalId: 'someone-else',
    });

    await expect(
      service.revokeOwnSession(SessionPrincipalType.CLIENT, 'client-1', 'session-1'),
    ).rejects.toThrow(NotFoundException);
  });

  describe('listActiveSessions', () => {
    it('lists non-revoked, non-expired sessions ordered by lastUsedAt, defaulting to page 1/limit 25', async () => {
      prisma.session.findMany.mockResolvedValue([]);
      prisma.session.count.mockResolvedValue(0);

      const result = await service.listActiveSessions(SessionPrincipalType.CLIENT, 'client-1');

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            principalType: SessionPrincipalType.CLIENT,
            principalId: 'client-1',
            revokedAt: null,
          }),
          orderBy: { lastUsedAt: 'desc' },
          skip: 0,
          take: 25,
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('applies a createdAt date range', async () => {
      prisma.session.findMany.mockResolvedValue([]);
      prisma.session.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.listActiveSessions(SessionPrincipalType.CLIENT, 'client-1', { createdFrom, createdTo });

      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('maps each row to a SessionSummary shape and computes skip/take from page and limit', async () => {
      prisma.session.findMany.mockResolvedValue([
        {
          id: 's1',
          userAgent: 'jest',
          ip: '127.0.0.1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: new Date('2026-01-02'),
          expiresAt: new Date('2026-02-01'),
        },
      ]);
      prisma.session.count.mockResolvedValue(6);

      const result = await service.listActiveSessions(SessionPrincipalType.CLIENT, 'client-1', {}, { page: 2, limit: 3 });

      expect(prisma.session.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 3, take: 3 }));
      expect(result.data).toEqual([
        {
          id: 's1',
          userAgent: 'jest',
          ip: '127.0.0.1',
          createdAt: new Date('2026-01-01'),
          lastUsedAt: new Date('2026-01-02'),
          expiresAt: new Date('2026-02-01'),
        },
      ]);
      expect(result.meta).toEqual({ total: 6, page: 2, limit: 3, totalPages: 2 });
    });
  });
});

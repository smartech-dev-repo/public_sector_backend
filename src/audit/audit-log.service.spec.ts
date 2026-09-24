import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { AuditActorType } from '../generated/prisma/client';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };
  let principalResolver: { resolveMany: jest.Mock };

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
    principalResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    service = new AuditLogService(prisma as unknown as PrismaService, principalResolver as unknown as PrincipalResolverService);
  });

  it('writes a row with every provided field', async () => {
    await service.record({
      actorType: AuditActorType.ADMIN,
      actorId: 'admin-1',
      action: 'admin.invite.created',
      targetType: 'AdminInvite',
      targetId: 'invite-1',
      metadata: { email: 'new-admin@example.com' },
      ip: '127.0.0.1',
      userAgent: 'jest-test',
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: AuditActorType.ADMIN,
        actorId: 'admin-1',
        action: 'admin.invite.created',
        targetType: 'AdminInvite',
        targetId: 'invite-1',
        metadata: { email: 'new-admin@example.com' },
        ip: '127.0.0.1',
        userAgent: 'jest-test',
      },
    });
  });

  it('writes a row with only the required fields', async () => {
    await service.record({ actorType: AuditActorType.SYSTEM, action: 'session.reuse_detected' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorType: AuditActorType.SYSTEM,
        actorId: undefined,
        action: 'session.reuse_detected',
        targetType: undefined,
        targetId: undefined,
        metadata: undefined,
        ip: undefined,
        userAgent: undefined,
      },
    });
  });

  describe('list', () => {
    it('filters and orders newest-first, defaulting to page 1/limit 25', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      const result = await service.list({ actorType: AuditActorType.ADMIN });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
        where: {
          actorType: AuditActorType.ADMIN,
          action: undefined,
          targetType: undefined,
          targetId: undefined,
          createdAt: undefined,
        },
        orderBy: { createdAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('applies a createdAt date range', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.list({ createdFrom, createdTo });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(40);

      const result = await service.list({}, { page: 2, limit: 20 });

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
      expect(result.meta).toEqual({ total: 40, page: 2, limit: 20, totalPages: 2 });
    });

    it('attaches resolved actor and target objects to each row', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        {
          id: 'log-1',
          actorType: AuditActorType.ADMIN,
          actorId: 'admin-1',
          action: 'client.sessions.revoked',
          targetType: 'Client',
          targetId: 'client-1',
        },
      ]);
      prisma.auditLog.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(
        new Map<string, unknown>([
          ['ADMIN:admin-1', { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }],
          ['Client:client-1', { id: 'client-1', phone: '0801', status: 'VERIFIED' }],
        ]),
      );

      const result = await service.list();

      expect(principalResolver.resolveMany).toHaveBeenCalledWith([
        { type: AuditActorType.ADMIN, id: 'admin-1' },
        { type: 'Client', id: 'client-1' },
      ]);
      expect(result.data[0].actor).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
      expect(result.data[0].target).toEqual({ id: 'client-1', phone: '0801', status: 'VERIFIED' });
    });

    it('attaches null actor/target when the row has no target or is unresolvable', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        { id: 'log-1', actorType: AuditActorType.SYSTEM, actorId: null, action: 'session.reuse_detected', targetType: null, targetId: null },
      ]);
      prisma.auditLog.count.mockResolvedValue(1);
      principalResolver.resolveMany.mockResolvedValue(new Map());

      const result = await service.list();

      expect(result.data[0].actor).toBeNull();
      expect(result.data[0].target).toBeNull();
    });
  });
});

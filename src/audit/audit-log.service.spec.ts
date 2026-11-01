import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { PrincipalResolverService } from '../common/principal-resolver.service';
import { AuditActorType } from '../generated/prisma/client';
import { auditRequestContext } from './audit-request-context';
import { AuditAlertService } from './audit-alert.service';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock } };
  let principalResolver: { resolveMany: jest.Mock };

  let auditAlertService: { evaluate: jest.Mock };

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn() } };
    principalResolver = { resolveMany: jest.fn().mockResolvedValue(new Map()) };
    auditAlertService = { evaluate: jest.fn().mockResolvedValue(undefined) };
    service = new AuditLogService(
      prisma as unknown as PrismaService,
      principalResolver as unknown as PrincipalResolverService,
      auditAlertService as unknown as AuditAlertService,
    );
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

  it('fills ip and userAgent from the current request', async () => {
    await auditRequestContext.run({ ip: '10.0.0.1', userAgent: 'jest' }, () =>
      service.record({ actorType: AuditActorType.ADMIN, action: 'role.updated' }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ip: '10.0.0.1', userAgent: 'jest' }),
    });
  });

  it('keeps an explicitly passed ip over the request context', async () => {
    await auditRequestContext.run({ ip: '10.0.0.1' }, () =>
      service.record({ actorType: AuditActorType.SYSTEM, action: 'session.reuse_detected', ip: '10.0.0.2' }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ip: '10.0.0.2' }) });
  });

  describe('list', () => {
    it('kind=event excludes baseline request rows and kind=request keeps only them', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);

      await service.list({ kind: 'event' });
      expect(prisma.auditLog.findMany.mock.calls[0][0].where.NOT).toEqual({ action: { contains: ' /' } });

      await service.list({ kind: 'request' });
      expect(prisma.auditLog.findMany.mock.calls[1][0].where.action).toEqual({ contains: ' /' });
    });

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

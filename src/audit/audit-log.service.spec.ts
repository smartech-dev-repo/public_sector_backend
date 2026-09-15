import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType } from '../generated/prisma/client';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let prisma: { auditLog: { create: jest.Mock; findMany: jest.Mock } };

  beforeEach(() => {
    prisma = { auditLog: { create: jest.fn(), findMany: jest.fn() } };
    service = new AuditLogService(prisma as unknown as PrismaService);
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

  it('lists entries filtered and ordered newest-first', async () => {
    prisma.auditLog.findMany.mockResolvedValue([]);

    await service.list({ actorType: AuditActorType.ADMIN });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        actorType: AuditActorType.ADMIN,
        action: undefined,
        targetType: undefined,
        targetId: undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
});

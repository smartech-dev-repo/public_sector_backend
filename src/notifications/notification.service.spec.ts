import { NotificationService } from './notification.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NotificationService', () => {
  let prisma: { notification: { create: jest.Mock; findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock; groupBy: jest.Mock } };
  let service: NotificationService;

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn(),
        groupBy: jest.fn(),
      },
    };
    service = new NotificationService(prisma as unknown as PrismaService);
  });

  it('turns a confirmed loan into a notification for loan reviewers, linking to the loan', async () => {
    await service.fromAuditEvent({ action: 'loan-request.code_confirmed', actorType: 'CLIENT', targetId: 'lr1' });
    expect(prisma.notification.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ category: 'loans', link: '/dashboard/loan-requests/lr1', targetPermissions: ['loan-requests:review'] }),
    );
  });

  it('only flags a client when their face match failed', async () => {
    await service.fromAuditEvent({ action: 'client.onboarding.face_match', actorType: 'CLIENT', targetId: 'c1', metadata: { faceMatchPassed: true } });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    await service.fromAuditEvent({ action: 'client.onboarding.face_match', actorType: 'CLIENT', targetId: 'c1', metadata: { faceMatchPassed: false } });
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
  });

  it('does not tell an admin about their own action', async () => {
    await service.fromAuditEvent({ action: 'admin.2fa.disabled', actorType: 'ADMIN', actorId: 'a1' });
    expect(prisma.notification.create.mock.calls[0][0].data.excludeAdminId).toBe('a1');
  });

  it('ignores everyday events', async () => {
    await service.fromAuditEvent({ action: 'role.created', actorType: 'ADMIN' });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    prisma.notification.create.mockRejectedValue(new Error('db down'));
    await expect(service.notify({ category: 'x', title: 't', body: 'b', link: '/' })).resolves.toBeUndefined();
  });

  it('only returns what the admin is allowed to see', async () => {
    await service.list({ sub: 'a1', type: 'admin', permissions: ['audit:read'] }, {}, { page: 1, limit: 25 });
    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual([
      { recipientAdminId: 'a1' },
      { recipientAdminId: null, targetPermissions: { hasSome: ['audit:read'] } },
    ]);
  });
});

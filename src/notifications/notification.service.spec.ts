import { NotificationService } from './notification.service';
import { PrismaService } from '../prisma/prisma.service';

describe('NotificationService', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: NotificationService;

  beforeEach(() => {
    prisma = {
      permission: { findMany: jest.fn().mockResolvedValue([]) },
      adminUser: {
        findUnique: jest.fn().mockResolvedValue({ role: { permissions: [{ permission: { key: 'audit:read' } }] } }),
      },
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
      expect.objectContaining({ category: 'loans', link: '/dashboard/loan-requests/lr1', targetPermissions: ['loan-requests:manage', 'loan-requests:reject'] }),
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

  it('only returns what the admin is allowed to see, by their live permissions', async () => {
    await service.list({ sub: 'a1', type: 'admin', permissions: [] }, {}, { page: 1, limit: 25 });
    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.AND[0].OR).toEqual([
      { recipientAdminId: 'a1' },
      { recipientAdminId: null, targetPermissions: { hasSome: ['audit:read'] } },
    ]);
  });

  it('treats SUPER_ADMIN as holding every permission, even without the role rows', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ role: { name: 'SUPER_ADMIN', permissions: [] } });
    prisma.permission.findMany.mockResolvedValue([{ key: 'approvals:agents' }, { key: 'approvals:loans' }]);
    await expect(service.currentPermissions('sa')).resolves.toEqual(['approvals:agents', 'approvals:loans']);
  });

  describe('actionAlerts', () => {
    beforeEach(() => {
      Object.assign(prisma, {
        approvalRequest: { findMany: jest.fn().mockResolvedValue([]) },
        loanRequest: { count: jest.fn().mockResolvedValue(3) },
        documentUploadBatch: { count: jest.fn().mockResolvedValue(2) },
        client: { count: jest.fn().mockResolvedValue(4) },
        agent: { count: jest.fn().mockResolvedValue(5) },
        deviceReleaseRequest: { count: jest.fn().mockResolvedValue(6) },
        sector: { findMany: jest.fn().mockResolvedValue([{ code: 'NPF' }, { code: 'CUSTOMS' }, { code: 'LASG' }]) },
        loanProduct: { findMany: jest.fn().mockResolvedValue([{ sectors: ['NPF'] }, { sectors: ['CUSTOMS'] }]) },
      });
    });

    it('counts only what each permission can act on', async () => {
      await expect(service.actionAlerts(['loan-requests:manage'])).resolves.toEqual({
        loanRequests: 3, loanProducts: 0, broadsheet: 0, clients: 0, agentRecruitment: 0, deviceReleases: 0,
      });
      expect(prisma.client.count).not.toHaveBeenCalled();
      expect(prisma.agent.count).not.toHaveBeenCalled();
    });

    it('counts every area for an admin who holds everything', async () => {
      const all = ['loan-requests:manage', 'loan-requests:disburse', 'loan-products:manage', 'ippis:upload', 'loans:upload', 'repayments:upload', 'clients:review', 'agents:review', 'devices:manage'];
      await expect(service.actionAlerts(all)).resolves.toEqual({
        loanRequests: 3, loanProducts: 1, broadsheet: 2, clients: 4, agentRecruitment: 5, deviceReleases: 6,
      });
    });

    it('counts decisions, not activity: confirmed or approved loans, uploads awaiting confirmation, manual-review clients, unreviewed agents', async () => {
      await service.actionAlerts(['loan-requests:manage', 'loan-requests:disburse', 'ippis:upload', 'clients:review', 'agents:review']);
      expect(prisma.loanRequest.count.mock.calls[0][0].where.status).toEqual({ in: ['CONFIRMED', 'APPROVED'] });
      expect(prisma.documentUploadBatch.count.mock.calls[0][0].where).toEqual({
        status: 'AWAITING_CONFIRMATION', documentType: { in: ['IPPIS_BROADSHEET'] },
      });
      expect(prisma.client.count.mock.calls[0][0].where).toEqual({ status: 'MANUAL_REVIEW' });
      expect(prisma.agent.count.mock.calls[0][0].where.status).toBe('PENDING_REVIEW');
    });

    it('leaves work already sent for approval to the Approvals count', async () => {
      prisma.approvalRequest.findMany.mockResolvedValue([
        { targetType: 'LoanRequest', targetId: 'lr1' },
        { targetType: 'Agent', targetId: 'a1' },
      ]);
      await service.actionAlerts(['loan-requests:manage', 'agents:review']);
      expect(prisma.loanRequest.count.mock.calls[0][0].where.id).toEqual({ notIn: ['lr1'] });
      expect(prisma.agent.count.mock.calls[0][0].where.id).toEqual({ notIn: ['a1'] });
    });

    it('counts loans by the actions the admin holds', async () => {
      await service.actionAlerts(['loan-requests:disburse']);
      expect(prisma.loanRequest.count.mock.calls[0][0].where.status).toEqual({ in: ['APPROVED'] });
    });

    it('counts only clients in the admin\'s record scope unless they hold all records', async () => {
      await service.actionAlerts(['loan-requests:manage', 'clients:review'], 'admin-1');
      const own = { assignedAdminId: 'admin-1' };
      expect(prisma.loanRequest.count.mock.calls[0][0].where.client).toEqual(own);
      expect(prisma.client.count.mock.calls[0][0].where.AND).toEqual([own]);
      await service.actionAlerts(['loan-requests:manage', 'clients:all-records'], 'admin-1');
      expect(prisma.loanRequest.count.mock.calls[1][0].where.client).toBeUndefined();
    });
  });
});

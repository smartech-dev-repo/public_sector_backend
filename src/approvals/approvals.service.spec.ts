import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { AuditLogService } from '../audit/audit-log.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/jwt-payload.interface';

const approver = (sub: string): JwtPayload => ({ sub, type: 'admin', permissions: ['approvals:loans'] });
const pending = (overrides = {}) => ({
  id: 'ap1',
  action: 'loan-request.approve',
  status: 'PENDING',
  requiredPermission: 'approvals:loans',
  targetId: 'lr1',
  summary: { title: 'Approve and disburse loan', subject: 'Ada' },
  payload: {},
  requestedById: 'maker',
  assignedToId: null,
  ...overrides,
});

describe('ApprovalsService', () => {
  let prisma: {
    approvalRequest: { create: jest.Mock; findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    adminUser: { findMany: jest.Mock; findFirst: jest.Mock };
  };
  let audit: { record: jest.Mock };
  let notifications: { notify: jest.Mock; currentPermissions: jest.Mock };
  let handler: jest.Mock;
  let service: ApprovalsService;

  beforeEach(() => {
    prisma = {
      approvalRequest: {
        create: jest.fn().mockResolvedValue(pending()),
        findUnique: jest.fn().mockResolvedValue(pending()),
        findFirst: jest.fn().mockResolvedValue(pending()),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminUser: { findMany: jest.fn(), findFirst: jest.fn().mockResolvedValue({ id: 'other', fullName: 'Other' }) },
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      notify: jest.fn().mockResolvedValue(undefined),
      currentPermissions: jest.fn().mockResolvedValue(['approvals:loans']),
    };
    handler = jest.fn().mockResolvedValue(undefined);
    service = new ApprovalsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditLogService,
      notifications as unknown as NotificationService,
    );
    service.register('loan-request.approve', handler);
  });

  const submission = {
    action: 'loan-request.approve',
    requiredPermission: 'approvals:loans',
    targetType: 'LoanRequest',
    targetId: 'lr1',
    summary: { title: 'Approve and disburse loan' },
    requestedById: 'maker',
  };

  describe('submit', () => {
    it('tells approvers but not the maker', async () => {
      await service.submit(submission);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ targetPermissions: ['approvals:loans'], excludeAdminId: 'maker', link: '/dashboard/approvals/ap1' }),
      );
    });

    it('refuses a second open request for the same action and record', async () => {
      prisma.approvalRequest.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
      await expect(service.submit(submission)).rejects.toThrow('already waiting for approval');
    });

    it('lets wallet-style requests run side by side', async () => {
      await service.submit({ ...submission, allowParallel: true });
      expect(prisma.approvalRequest.create.mock.calls[0][0].data.pendingKey).toBeNull();
    });
  });

  describe('deciding', () => {
    it('refuses the maker, even as a Super Admin holding every permission', async () => {
      await expect(service.approve(approver('maker'), 'ap1')).rejects.toThrow(ForbiddenException);
      expect(handler).not.toHaveBeenCalled();
    });

    it('refuses an admin without the permission', async () => {
      notifications.currentPermissions.mockResolvedValue([]);
      await expect(service.approve({ sub: 'x', type: 'admin', permissions: ['approvals:loans'] }, 'ap1')).rejects.toThrow(ForbiddenException);
    });

    it('runs the action as the checker', async () => {
      await service.approve(approver('checker'), 'ap1');
      expect(handler).toHaveBeenCalledWith({}, expect.objectContaining({ id: 'ap1' }), 'checker');
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientAdminId: 'maker', title: 'Your request was approved' }));
    });

    it('never runs twice when two admins decide at once', async () => {
      prisma.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve(approver('checker'), 'ap1')).rejects.toThrow(ConflictException);
      expect(handler).not.toHaveBeenCalled();
    });

    it('marks it failed, not approved, when the action cannot complete', async () => {
      handler.mockRejectedValue(new ConflictException('Loan request must be CONFIRMED to approve'));

      await expect(service.approve(approver('checker'), 'ap1')).rejects.toThrow('must be CONFIRMED');

      expect(prisma.approvalRequest.update).toHaveBeenCalledWith({
        where: { id: 'ap1' },
        data: { status: 'FAILED', failureReason: 'Loan request must be CONFIRMED to approve' },
      });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'approval.failed' }));
    });

    it('rejecting keeps the reason and runs nothing', async () => {
      await service.reject(approver('checker'), 'ap1', 'Wrong amount');

      expect(handler).not.toHaveBeenCalled();
      expect(prisma.approvalRequest.updateMany.mock.calls[0][0].data).toEqual(
        expect.objectContaining({ status: 'REJECTED', decisionNote: 'Wrong amount' }),
      );
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ body: 'Wrong amount', recipientAdminId: 'maker' }));
    });
  });

  describe('assignment', () => {
    it('only the assigned admin can decide, even over another approver', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pending({ assignedToId: 'chosen' }));
      await expect(service.approve(approver('other'), 'ap1')).rejects.toThrow('assigned to another admin');
    });

    it('the assigned admin can decide without holding the permission', async () => {
      prisma.approvalRequest.findUnique.mockResolvedValue(pending({ assignedToId: 'chosen' }));
      notifications.currentPermissions.mockResolvedValue([]);
      await service.approve({ sub: 'chosen', type: 'admin', permissions: [] }, 'ap1');
      expect(handler).toHaveBeenCalled();
    });

    it('a maker cannot be assigned their own request', async () => {
      await expect(service.assign(approver('checker'), 'ap1', 'maker')).rejects.toThrow(ForbiddenException);
    });

    it('a maker can choose who decides their own request, without the approval permission', async () => {
      notifications.currentPermissions.mockResolvedValue([]);
      await service.assign({ sub: 'maker', type: 'admin', permissions: [] }, 'ap1', 'other');
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientAdminId: 'other' }));
    });

    it('only offers and accepts admins who hold the approval permission', async () => {
      prisma.adminUser.findMany.mockResolvedValue([]);
      await service.listAssignees(approver('checker'), 'ap1');
      await service.assign(approver('checker'), 'ap1', 'other');
      const role = { OR: [{ name: 'SUPER_ADMIN' }, { permissions: { some: { permission: { key: 'approvals:loans' } } } }] };
      expect(prisma.adminUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role }) }));
      expect(prisma.adminUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role, id: 'other' }) }));
    });

    it('an unrelated admin without the permission cannot assign', async () => {
      notifications.currentPermissions.mockResolvedValue([]);
      await expect(service.assign({ sub: 'stranger', type: 'admin', permissions: [] }, 'ap1', 'other')).rejects.toThrow(ForbiddenException);
    });

    it('tells the assignee', async () => {
      await service.assign(approver('checker'), 'ap1', 'other');
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientAdminId: 'other' }));
    });

    it('refuses an unknown or deactivated admin', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(null);
      await expect(service.assign(approver('checker'), 'ap1', 'gone')).rejects.toThrow(NotFoundException);
    });
  });

  it('uses live permissions, not the ones in an old sign-in token', async () => {
    notifications.currentPermissions.mockResolvedValue(['approvals:loans']);
    await service.approve({ sub: 'checker', type: 'admin', permissions: [] }, 'ap1');
    expect(handler).toHaveBeenCalled();
  });

  it('only the maker can withdraw a request', async () => {
    await expect(service.cancel(approver('someone'), 'ap1')).rejects.toThrow(NotFoundException);
    await service.cancel(approver('maker'), 'ap1');
    expect(prisma.approvalRequest.updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({ status: 'CANCELLED' }));
  });
});

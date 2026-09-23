import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';

describe('AdminRoleAssignmentService', () => {
  let service: AdminRoleAssignmentService;
  let prisma: {
    adminUser: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; count: jest.Mock };
    role: { findUnique: jest.Mock };
  };
  let sessionService: { revokeAllForPrincipal: jest.Mock };

  beforeEach(() => {
    prisma = {
      adminUser: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
      role: { findUnique: jest.fn() },
    };
    sessionService = { revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined) };
    service = new AdminRoleAssignmentService(prisma as unknown as PrismaService, sessionService as unknown as SessionService);
  });

  it('listAdmins returns admins with role and department included', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    await service.listAdmins();
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ role: true, department: true }) }),
    );
  });

  it('listAdmins filters by isActive and searches email/fullName', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    prisma.adminUser.count.mockResolvedValue(0);

    await service.listAdmins({ isActive: false, q: 'bello' });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: false,
          OR: [
            { email: { contains: 'bello', mode: 'insensitive' } },
            { fullName: { contains: 'bello', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('listAdmins applies a createdAt date range', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    prisma.adminUser.count.mockResolvedValue(0);
    const createdFrom = new Date('2025-01-01');
    const createdTo = new Date('2025-12-31');

    await service.listAdmins({ createdFrom, createdTo });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
    );
  });

  it('listAdmins computes skip/take from page and limit and reports the total', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    prisma.adminUser.count.mockResolvedValue(4);

    const result = await service.listAdmins({}, { page: 1, limit: 2 });

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 2 }));
    expect(result.meta).toEqual({ total: 4, page: 1, limit: 2, totalPages: 2 });
  });

  describe('setRole', () => {
    it('throws NotFoundException for an unknown admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.setRole('missing-admin', 'role-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for an unknown role', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue(null);
      await expect(service.setRole('admin-1', 'missing-role')).rejects.toThrow(NotFoundException);
    });

    it('sets the new roleId and copies the new role\'s departmentId', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'APPROVER', departmentId: 'dept-1' });

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { roleId: 'role-new', departmentId: 'dept-1' },
      });
    });

    it('copies a null departmentId when the new role has none', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'APPROVER', departmentId: null });

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { roleId: 'role-new', departmentId: null },
      });
    });

    it('allows moving an admin off SUPER_ADMIN when other admins still hold it', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'super-admin-role', name: 'SUPER_ADMIN' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'REVIEWER', departmentId: null });
      prisma.adminUser.count.mockResolvedValue(2);

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.update).toHaveBeenCalled();
    });

    it('rejects moving the last SUPER_ADMIN holder to a different role', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'super-admin-role', name: 'SUPER_ADMIN' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'REVIEWER', departmentId: null });
      prisma.adminUser.count.mockResolvedValue(1);

      await expect(service.setRole('admin-1', 'role-new')).rejects.toThrow(ConflictException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('does not apply the last-holder guard when the admin is already SUPER_ADMIN and stays SUPER_ADMIN', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'super-admin-role', name: 'SUPER_ADMIN' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'super-admin-role', name: 'SUPER_ADMIN', departmentId: null });

      await service.setRole('admin-1', 'super-admin-role');

      expect(prisma.adminUser.count).not.toHaveBeenCalled();
      expect(prisma.adminUser.update).toHaveBeenCalled();
    });

    it('does not apply the last-holder guard when the admin is not currently SUPER_ADMIN', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({
        id: 'admin-1',
        role: { id: 'role-current', name: 'REVIEWER' },
      });
      prisma.role.findUnique.mockResolvedValue({ id: 'role-new', name: 'APPROVER', departmentId: null });

      await service.setRole('admin-1', 'role-new');

      expect(prisma.adminUser.count).not.toHaveBeenCalled();
      expect(prisma.adminUser.update).toHaveBeenCalled();
    });
  });

  describe('suspend', () => {
    it('throws NotFoundException when the admin does not exist', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.suspend('caller-1', 'missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when suspending your own account', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'caller-1', isActive: true });
      await expect(service.suspend('caller-1', 'caller-1')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the admin is already suspended', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
      await expect(service.suspend('caller-1', 'admin-2')).rejects.toThrow(ConflictException);
    });

    it('suspends the admin and revokes their sessions', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
      prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: false });

      await service.suspend('caller-1', 'admin-2');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-2' },
        data: { isActive: false },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('ADMIN', 'admin-2', 'admin_suspended');
    });
  });

  describe('unsuspend', () => {
    it('throws NotFoundException when the admin does not exist', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.unsuspend('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the admin is already active', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
      await expect(service.unsuspend('admin-2')).rejects.toThrow(ConflictException);
    });

    it('unsuspends the admin without touching sessions', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
      prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: true });

      await service.unsuspend('admin-2');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-2' },
        data: { isActive: true },
      });
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });
  });
});

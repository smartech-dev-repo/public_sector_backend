import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminRoleAssignmentService } from './admin-role-assignment.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';

describe('AdminRoleAssignmentService', () => {
  let service: AdminRoleAssignmentService;
  let prisma: {
    adminUser: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    role: { findUnique: jest.Mock };
    adminUserRole: { upsert: jest.Mock; deleteMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock };
  };
  let sessionService: { revokeAllForPrincipal: jest.Mock };

  beforeEach(() => {
    prisma = {
      adminUser: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      role: { findUnique: jest.fn() },
      adminUserRole: { upsert: jest.fn(), deleteMany: jest.fn(), count: jest.fn(), findUnique: jest.fn() },
    };
    sessionService = { revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined) };
    service = new AdminRoleAssignmentService(prisma as unknown as PrismaService, sessionService as unknown as SessionService);
  });

  it('listAdmins returns admins with roles included', async () => {
    prisma.adminUser.findMany.mockResolvedValue([]);
    await service.listAdmins();
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ roles: expect.anything() }) }),
    );
  });

  it('assignRole throws NotFoundException for an unknown admin', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(service.assignRole('missing-admin', 'role-1')).rejects.toThrow(NotFoundException);
  });

  it('assignRole throws NotFoundException for an unknown role', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.role.findUnique.mockResolvedValue(null);
    await expect(service.assignRole('admin-1', 'missing-role')).rejects.toThrow(NotFoundException);
  });

  it('assignRole upserts the AdminUserRole row', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1' });
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    await service.assignRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.upsert).toHaveBeenCalledWith({
      where: { adminUserId_roleId: { adminUserId: 'admin-1', roleId: 'role-1' } },
      update: {},
      create: { adminUserId: 'admin-1', roleId: 'role-1' },
    });
  });

  it('removeRole allows removing a non-SUPER_ADMIN role freely', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    await service.removeRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.deleteMany).toHaveBeenCalledWith({ where: { adminUserId: 'admin-1', roleId: 'role-1' } });
  });

  it('removeRole allows removing SUPER_ADMIN when other admins still hold it', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.adminUserRole.findUnique.mockResolvedValue({ adminUserId: 'admin-1', roleId: 'role-1' });
    prisma.adminUserRole.count.mockResolvedValue(2);
    await service.removeRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.deleteMany).toHaveBeenCalled();
  });

  it('removeRole rejects removing the last SUPER_ADMIN holder', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.adminUserRole.findUnique.mockResolvedValue({ adminUserId: 'admin-1', roleId: 'role-1' });
    prisma.adminUserRole.count.mockResolvedValue(1);
    await expect(service.removeRole('admin-1', 'role-1')).rejects.toThrow(ConflictException);
    expect(prisma.adminUserRole.deleteMany).not.toHaveBeenCalled();
  });

  it('removeRole is a no-op (not an error) if the admin never had SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.adminUserRole.findUnique.mockResolvedValue(null);
    await service.removeRole('admin-1', 'role-1');
    expect(prisma.adminUserRole.deleteMany).toHaveBeenCalled();
  });

  describe('deactivate', () => {
    it('throws NotFoundException when the admin does not exist', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.deactivate('caller-1', 'missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when deactivating your own account', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'caller-1', isActive: true });
      await expect(service.deactivate('caller-1', 'caller-1')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the admin is already inactive', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
      await expect(service.deactivate('caller-1', 'admin-2')).rejects.toThrow(ConflictException);
    });

    it('deactivates the admin and revokes their sessions', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
      prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: false });

      await service.deactivate('caller-1', 'admin-2');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-2' },
        data: { isActive: false },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('ADMIN', 'admin-2', 'admin_deactivated');
    });
  });

  describe('reactivate', () => {
    it('throws NotFoundException when the admin does not exist', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);
      await expect(service.reactivate('missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the admin is already active', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: true });
      await expect(service.reactivate('admin-2')).rejects.toThrow(ConflictException);
    });

    it('reactivates the admin without touching sessions', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-2', isActive: false });
      prisma.adminUser.update.mockResolvedValue({ id: 'admin-2', isActive: true });

      await service.reactivate('admin-2');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-2' },
        data: { isActive: true },
      });
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });
  });
});

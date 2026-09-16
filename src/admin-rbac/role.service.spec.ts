import { ConflictException, NotFoundException } from '@nestjs/common';
import { RoleService } from './role.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RoleService', () => {
  let service: RoleService;
  let prisma: {
    role: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock };
    adminUserRole: { count: jest.Mock };
    permission: { findUnique: jest.Mock };
    rolePermission: { upsert: jest.Mock; deleteMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      role: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), delete: jest.fn() },
      adminUserRole: { count: jest.fn() },
      permission: { findUnique: jest.fn() },
      rolePermission: { upsert: jest.fn(), deleteMany: jest.fn() },
    };
    service = new RoleService(prisma as unknown as PrismaService);
  });

  it('create converts a duplicate-name DB error into ConflictException', async () => {
    prisma.role.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ name: 'SUPER_ADMIN' })).rejects.toThrow(ConflictException);
  });

  it('findById throws NotFoundException for an unknown id', async () => {
    prisma.role.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('update rejects renaming SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    await expect(service.update('role-1', { name: 'NOT_SUPER_ADMIN' })).rejects.toThrow(ConflictException);
    expect(prisma.role.update).not.toHaveBeenCalled();
  });

  it('update allows editing SUPER_ADMIN description without touching name', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN', description: 'new' });
    await service.update('role-1', { description: 'new' });
    expect(prisma.role.update).toHaveBeenCalledWith({ where: { id: 'role-1' }, data: { name: undefined, description: 'new' } });
  });

  it('remove rejects deleting SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    await expect(service.remove('role-1')).rejects.toThrow(ConflictException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('remove rejects deleting a role assigned to any admin', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    prisma.adminUserRole.count.mockResolvedValue(2);
    await expect(service.remove('role-1')).rejects.toThrow(ConflictException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('remove deletes an unused, non-SUPER_ADMIN role', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    prisma.adminUserRole.count.mockResolvedValue(0);
    await service.remove('role-1');
    expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: 'role-1' } });
  });

  it('assignPermission throws NotFoundException for an unknown permission', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    prisma.permission.findUnique.mockResolvedValue(null);
    await expect(service.assignPermission('role-1', 'missing-perm')).rejects.toThrow(NotFoundException);
  });

  it('assignPermission upserts the RolePermission row', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1' });
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    await service.assignPermission('role-1', 'perm-1');
    expect(prisma.rolePermission.upsert).toHaveBeenCalledWith({
      where: { roleId_permissionId: { roleId: 'role-1', permissionId: 'perm-1' } },
      update: {},
      create: { roleId: 'role-1', permissionId: 'perm-1' },
    });
  });

  it('removePermission deletes the RolePermission row', async () => {
    await service.removePermission('role-1', 'perm-1');
    expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role-1', permissionId: 'perm-1' } });
  });
});

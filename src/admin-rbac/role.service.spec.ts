import { ConflictException, NotFoundException } from '@nestjs/common';
import { RoleService } from './role.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RoleService', () => {
  let service: RoleService;
  let prisma: {
    role: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    adminUser: { count: jest.Mock };
    permission: { findUnique: jest.Mock };
    rolePermission: { upsert: jest.Mock; deleteMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      role: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      adminUser: { count: jest.fn() },
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
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: 'new', departmentId: undefined },
    });
  });

  it('create stores the departmentId when given', async () => {
    prisma.role.create.mockResolvedValue({ id: 'role-2', name: 'REVIEWER', departmentId: 'dept-1' });
    await service.create({ name: 'REVIEWER', departmentId: 'dept-1' });
    expect(prisma.role.create).toHaveBeenCalledWith({ data: { name: 'REVIEWER', departmentId: 'dept-1' } });
  });

  it('update sets departmentId when given, and clears it when explicitly set to null', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'REVIEWER' });
    prisma.role.update.mockResolvedValue({ id: 'role-1', name: 'REVIEWER', departmentId: null });
    await service.update('role-1', { departmentId: null });
    expect(prisma.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { name: undefined, description: undefined, departmentId: null },
    });
  });

  it('remove rejects deleting SUPER_ADMIN', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'SUPER_ADMIN' });
    await expect(service.remove('role-1')).rejects.toThrow(ConflictException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('remove rejects deleting a role assigned to any admin', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    prisma.adminUser.count.mockResolvedValue(2);
    await expect(service.remove('role-1')).rejects.toThrow(ConflictException);
    expect(prisma.role.delete).not.toHaveBeenCalled();
  });

  it('remove deletes an unused, non-SUPER_ADMIN role', async () => {
    prisma.role.findUnique.mockResolvedValue({ id: 'role-1', name: 'CUSTOM_ROLE' });
    prisma.adminUser.count.mockResolvedValue(0);
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

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches by name', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(0);

      await service.list({ q: 'reviewer' });

      expect(prisma.role.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: { contains: 'reviewer', mode: 'insensitive' } } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.role.findMany.mockResolvedValue([]);
      prisma.role.count.mockResolvedValue(8);

      const result = await service.list({}, { page: 2, limit: 5 });

      expect(prisma.role.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
      expect(result.meta).toEqual({ total: 8, page: 2, limit: 5, totalPages: 2 });
    });
  });
});

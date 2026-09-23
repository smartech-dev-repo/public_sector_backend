import { ConflictException, NotFoundException } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PermissionService', () => {
  let service: PermissionService;
  let prisma: {
    permission: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    rolePermission: { count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      permission: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      rolePermission: { count: jest.fn() },
    };
    service = new PermissionService(prisma as unknown as PrismaService);
  });

  it('create stores the key and description', async () => {
    prisma.permission.create.mockResolvedValue({ id: 'perm-1', key: 'reports:export', description: 'Export reports' });
    const result = await service.create({ key: 'reports:export', description: 'Export reports' });
    expect(prisma.permission.create).toHaveBeenCalledWith({ data: { key: 'reports:export', description: 'Export reports' } });
    expect(result.id).toBe('perm-1');
  });

  it('create converts a duplicate-key DB error into ConflictException', async () => {
    prisma.permission.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ key: 'audit:read', description: 'dup' })).rejects.toThrow(ConflictException);
  });

  it('findById throws NotFoundException for an unknown id', async () => {
    prisma.permission.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('findById returns the permission when found', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    expect(await service.findById('perm-1')).toEqual({ id: 'perm-1' });
  });

  it('update only ever changes description, never key', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1', key: 'reports:export' });
    prisma.permission.update.mockResolvedValue({ id: 'perm-1', description: 'new desc' });
    await service.update('perm-1', { description: 'new desc' });
    expect(prisma.permission.update).toHaveBeenCalledWith({ where: { id: 'perm-1' }, data: { description: 'new desc' } });
  });

  it('update throws NotFoundException for an unknown id', async () => {
    prisma.permission.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { description: 'x' })).rejects.toThrow(NotFoundException);
  });

  it('remove throws ConflictException when the permission is assigned to a role', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    prisma.rolePermission.count.mockResolvedValue(1);
    await expect(service.remove('perm-1')).rejects.toThrow(ConflictException);
    expect(prisma.permission.delete).not.toHaveBeenCalled();
  });

  it('remove deletes the permission when unused', async () => {
    prisma.permission.findUnique.mockResolvedValue({ id: 'perm-1' });
    prisma.rolePermission.count.mockResolvedValue(0);
    await service.remove('perm-1');
    expect(prisma.permission.delete).toHaveBeenCalledWith({ where: { id: 'perm-1' } });
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.permission.findMany.mockResolvedValue([]);
      prisma.permission.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.permission.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches by key', async () => {
      prisma.permission.findMany.mockResolvedValue([]);
      prisma.permission.count.mockResolvedValue(0);

      await service.list({ q: 'audit' });

      expect(prisma.permission.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { key: { contains: 'audit', mode: 'insensitive' } } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.permission.findMany.mockResolvedValue([]);
      prisma.permission.count.mockResolvedValue(30);

      const result = await service.list({}, { page: 2, limit: 10 });

      expect(prisma.permission.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10 }));
      expect(result.meta).toEqual({ total: 30, page: 2, limit: 10, totalPages: 3 });
    });
  });
});

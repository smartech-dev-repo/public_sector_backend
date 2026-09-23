import { ConflictException, NotFoundException } from '@nestjs/common';
import { DepartmentService } from './department.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DepartmentService', () => {
  let service: DepartmentService;
  let prisma: {
    department: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      count: jest.Mock;
    };
    role: { count: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      department: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      role: { count: jest.fn() },
    };
    service = new DepartmentService(prisma as unknown as PrismaService);
  });

  it('create stores the name and description', async () => {
    prisma.department.create.mockResolvedValue({ id: 'dept-1', name: 'Finance', description: 'Finance team' });
    const result = await service.create({ name: 'Finance', description: 'Finance team' });
    expect(prisma.department.create).toHaveBeenCalledWith({ data: { name: 'Finance', description: 'Finance team' } });
    expect(result.id).toBe('dept-1');
  });

  it('create converts a duplicate-name DB error into ConflictException', async () => {
    prisma.department.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ name: 'Finance' })).rejects.toThrow(ConflictException);
  });

  it('findById throws NotFoundException for an unknown id', async () => {
    prisma.department.findUnique.mockResolvedValue(null);
    await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
  });

  it('update throws NotFoundException for an unknown id', async () => {
    prisma.department.findUnique.mockResolvedValue(null);
    await expect(service.update('missing', { name: 'X' })).rejects.toThrow(NotFoundException);
  });

  it('update updates the given fields', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1', name: 'Finance' });
    prisma.department.update.mockResolvedValue({ id: 'dept-1', name: 'Finance & Accounts' });
    await service.update('dept-1', { name: 'Finance & Accounts' });
    expect(prisma.department.update).toHaveBeenCalledWith({
      where: { id: 'dept-1' },
      data: { name: 'Finance & Accounts', description: undefined },
    });
  });

  it('remove rejects deleting a department assigned to any role', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1', name: 'Finance' });
    prisma.role.count.mockResolvedValue(1);
    await expect(service.remove('dept-1')).rejects.toThrow(ConflictException);
    expect(prisma.department.delete).not.toHaveBeenCalled();
  });

  it('remove deletes an unused department', async () => {
    prisma.department.findUnique.mockResolvedValue({ id: 'dept-1', name: 'Finance' });
    prisma.role.count.mockResolvedValue(0);
    await service.remove('dept-1');
    expect(prisma.department.delete).toHaveBeenCalledWith({ where: { id: 'dept-1' } });
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.department.count.mockResolvedValue(0);
      const result = await service.list();
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: undefined }, orderBy: { name: 'asc' }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('searches by name', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.department.count.mockResolvedValue(0);
      await service.list({ q: 'fina' });
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { name: { contains: 'fina', mode: 'insensitive' } } }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.department.findMany.mockResolvedValue([]);
      prisma.department.count.mockResolvedValue(9);
      const result = await service.list({}, { page: 2, limit: 4 });
      expect(prisma.department.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 4 }));
      expect(result.meta).toEqual({ total: 9, page: 2, limit: 4, totalPages: 3 });
    });
  });
});

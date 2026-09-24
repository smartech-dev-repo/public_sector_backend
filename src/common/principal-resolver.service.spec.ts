import { PrincipalResolverService } from './principal-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PrincipalResolverService', () => {
  let service: PrincipalResolverService;
  let prisma: {
    adminUser: { findMany: jest.Mock };
    agent: { findMany: jest.Mock };
    client: { findMany: jest.Mock };
    adminInvite: { findMany: jest.Mock };
    department: { findMany: jest.Mock };
    loanRequest: { findMany: jest.Mock };
    permission: { findMany: jest.Mock };
    role: { findMany: jest.Mock };
    ippisRecord: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      adminUser: { findMany: jest.fn() },
      agent: { findMany: jest.fn() },
      client: { findMany: jest.fn() },
      adminInvite: { findMany: jest.fn() },
      department: { findMany: jest.fn() },
      loanRequest: { findMany: jest.fn() },
      permission: { findMany: jest.fn() },
      role: { findMany: jest.fn() },
      ippisRecord: { findMany: jest.fn() },
    };
    service = new PrincipalResolverService(prisma as unknown as PrismaService);
  });

  it('resolves a single ADMIN ref to the projected AdminUser fields', async () => {
    prisma.adminUser.findMany.mockResolvedValue([{ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' }]);

    const result = await service.resolveMany([{ type: 'ADMIN', id: 'admin-1' }]);

    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['admin-1'] } },
      select: { id: true, fullName: true, email: true },
    });
    expect(result.get('ADMIN:admin-1')).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
  });

  it('does one query per distinct type in a batch, not one per ref', async () => {
    prisma.adminUser.findMany.mockResolvedValue([
      { id: 'admin-1', fullName: 'A', email: 'a@x.com' },
      { id: 'admin-2', fullName: 'B', email: 'b@x.com' },
    ]);
    prisma.client.findMany.mockResolvedValue([{ id: 'client-1', phone: '0801', status: 'VERIFIED' }]);

    const result = await service.resolveMany([
      { type: 'ADMIN', id: 'admin-1' },
      { type: 'ADMIN', id: 'admin-2' },
      { type: 'Client', id: 'client-1' },
    ]);

    expect(prisma.adminUser.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['admin-1', 'admin-2'] } },
      select: { id: true, fullName: true, email: true },
    });
    expect(prisma.client.findMany).toHaveBeenCalledTimes(1);
    expect(result.get('ADMIN:admin-1')).toEqual({ id: 'admin-1', fullName: 'A', email: 'a@x.com' });
    expect(result.get('ADMIN:admin-2')).toEqual({ id: 'admin-2', fullName: 'B', email: 'b@x.com' });
    expect(result.get('Client:client-1')).toEqual({ id: 'client-1', phone: '0801', status: 'VERIFIED' });
  });

  it('does not query for a SYSTEM ref or a null id, and the map has no entry for them', async () => {
    const result = await service.resolveMany([
      { type: 'SYSTEM', id: null },
      { type: 'ADMIN', id: null },
    ]);

    expect(prisma.adminUser.findMany).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('does not query for an unregistered type', async () => {
    const result = await service.resolveMany([{ type: 'NotARealType', id: 'x' }]);

    expect(result.size).toBe(0);
  });

  it('resolves every registered type to its documented projection', async () => {
    prisma.agent.findMany.mockResolvedValue([{ id: 'agent-1', fullName: 'Agent A', email: 'agent@x.com' }]);
    prisma.adminInvite.findMany.mockResolvedValue([{ id: 'invite-1', email: 'invited@x.com', status: 'PENDING' }]);
    prisma.department.findMany.mockResolvedValue([{ id: 'dept-1', name: 'Finance' }]);
    prisma.loanRequest.findMany.mockResolvedValue([{ id: 'lr-1', type: 'ORIGINATION', status: 'PENDING' }]);
    prisma.permission.findMany.mockResolvedValue([{ id: 'perm-1', key: 'admins:create' }]);
    prisma.role.findMany.mockResolvedValue([{ id: 'role-1', name: 'SUPER_ADMIN' }]);
    prisma.ippisRecord.findMany.mockResolvedValue([
      { id: 'ippis-1', staffId: 'NPF-001', employeeName: 'Jane Doe', agency: 'NPF' },
    ]);

    const result = await service.resolveMany([
      { type: 'AGENT', id: 'agent-1' },
      { type: 'AdminInvite', id: 'invite-1' },
      { type: 'Department', id: 'dept-1' },
      { type: 'LoanRequest', id: 'lr-1' },
      { type: 'Permission', id: 'perm-1' },
      { type: 'Role', id: 'role-1' },
      { type: 'IppisRecord', id: 'ippis-1' },
    ]);

    expect(result.get('AGENT:agent-1')).toEqual({ id: 'agent-1', fullName: 'Agent A', email: 'agent@x.com' });
    expect(result.get('AdminInvite:invite-1')).toEqual({ id: 'invite-1', email: 'invited@x.com', status: 'PENDING' });
    expect(result.get('Department:dept-1')).toEqual({ id: 'dept-1', name: 'Finance' });
    expect(result.get('LoanRequest:lr-1')).toEqual({ id: 'lr-1', type: 'ORIGINATION', status: 'PENDING' });
    expect(result.get('Permission:perm-1')).toEqual({ id: 'perm-1', key: 'admins:create' });
    expect(result.get('Role:role-1')).toEqual({ id: 'role-1', name: 'SUPER_ADMIN' });
    expect(result.get('IppisRecord:ippis-1')).toEqual({
      id: 'ippis-1',
      staffId: 'NPF-001',
      employeeName: 'Jane Doe',
      agency: 'NPF',
    });
  });
});

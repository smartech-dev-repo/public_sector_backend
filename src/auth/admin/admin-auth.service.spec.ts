import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: {
    adminUser: { findUnique: jest.Mock; create: jest.Mock };
  };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };
  let adminInviteService: { findValidByToken: jest.Mock; markAccepted: jest.Mock };

  beforeEach(() => {
    prisma = { adminUser: { findUnique: jest.fn(), create: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    adminInviteService = { findValidByToken: jest.fn(), markAccepted: jest.fn() };
    service = new AdminAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
      adminInviteService as unknown as AdminInviteService,
    );
  });

  it('rejects unknown emails', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    await expect(
      service.login('nobody@example.com', 'whatever'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a wrong password', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      passwordHash,
      isActive: true,
    });

    await expect(
      service.login('admin@example.com', 'wrong-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens via SessionService with flattened permissions on a correct login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique
      .mockResolvedValueOnce({ id: 'admin-1', email: 'admin@example.com', passwordHash, isActive: true })
      .mockResolvedValueOnce({
        id: 'admin-1',
        roles: [{ role: { permissions: [{ permission: { key: 'agents:read' } }] } }],
      });

    const result = await service.login('admin@example.com', 'correct-password', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['agents:read'],
    });
    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'ADMIN',
      principalId: 'admin-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
  });

  it('getPermissionsForAdmin flattens and de-duplicates permission keys', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      roles: [
        { role: { permissions: [{ permission: { key: 'agents:read' } }] } },
        { role: { permissions: [{ permission: { key: 'agents:read' } }, { permission: { key: 'roles:manage' } }] } },
      ],
    });

    const permissions = await service.getPermissionsForAdmin('admin-1');

    expect(permissions.sort()).toEqual(['agents:read', 'roles:manage']);
  });

  it('getPermissionsForAdmin returns an empty array for an unknown admin', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    expect(await service.getPermissionsForAdmin('nobody')).toEqual([]);
  });

  it('acceptInvite creates the AdminUser, assigns the invited role, and logs in', async () => {
    adminInviteService.findValidByToken.mockResolvedValue({
      id: 'invite-1',
      email: 'new-admin@example.com',
      roleId: 'role-1',
    });
    prisma.adminUser.create.mockResolvedValue({ id: 'admin-2' });
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-2',
      roles: [{ role: { permissions: [] } }],
    });

    const result = await service.acceptInvite('some-token', 'new-password', 'New Admin');

    expect(prisma.adminUser.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'new-admin@example.com',
        fullName: 'New Admin',
        roles: { create: { roleId: 'role-1' } },
      }),
    });
    expect(adminInviteService.markAccepted).toHaveBeenCalledWith('invite-1');
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});

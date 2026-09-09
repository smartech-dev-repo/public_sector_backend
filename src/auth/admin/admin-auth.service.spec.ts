import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: { adminUser: { findUnique: jest.Mock } };
  let tokenService: TokenService;

  beforeEach(() => {
    prisma = { adminUser: { findUnique: jest.fn() } };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
      signRefreshToken: jest.fn().mockReturnValue('refresh-token'),
    } as unknown as TokenService;
    service = new AdminAuthService(
      prisma as unknown as PrismaService,
      tokenService,
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
      roles: [],
    });

    await expect(
      service.login('admin@example.com', 'wrong-password'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('issues tokens with flattened permissions on a correct login', async () => {
    const passwordHash = await bcrypt.hash('correct-password', 12);
    prisma.adminUser.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      passwordHash,
      isActive: true,
      roles: [
        {
          role: {
            permissions: [{ permission: { key: 'agents:read' } }],
          },
        },
      ],
    });

    const result = await service.login('admin@example.com', 'correct-password');

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(tokenService.signAccessToken).toHaveBeenCalledWith({
      sub: 'admin-1',
      type: 'admin',
      permissions: ['agents:read'],
    });
  });
});

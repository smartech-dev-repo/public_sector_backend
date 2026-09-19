import { ConflictException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { verify as otplibVerify } from 'otplib';
import { AdminAuthService } from './admin-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { EmailService } from '../../email/email.service';

jest.mock('otplib', () => ({
  ...jest.requireActual('otplib'),
  verify: jest.fn(),
}));

describe('AdminAuthService', () => {
  let service: AdminAuthService;
  let prisma: {
    adminUser: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock; revokeAllForPrincipal: jest.Mock };
  let adminInviteService: { findValidByToken: jest.Mock; markAccepted: jest.Mock };
  let emailService: { send: jest.Mock };

  beforeEach(() => {
    prisma = {
      adminUser: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = {
      createSession: jest.fn().mockResolvedValue('refresh-token'),
      revokeAllForPrincipal: jest.fn().mockResolvedValue(undefined),
    };
    adminInviteService = { findValidByToken: jest.fn(), markAccepted: jest.fn() };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    service = new AdminAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
      adminInviteService as unknown as AdminInviteService,
      emailService as unknown as EmailService,
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

  describe('forgotPassword', () => {
    it('does nothing observable when the email does not match an active admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue(null);

      await service.forgotPassword('nobody@example.com');

      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does nothing observable for a deactivated admin', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', email: 'a@example.com', isActive: false });

      await service.forgotPassword('a@example.com');

      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates a reset token, stores its hash, and emails it', async () => {
      prisma.adminUser.findUnique.mockResolvedValue({ id: 'admin-1', email: 'a@example.com', isActive: true });

      await service.forgotPassword('a@example.com');

      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({
            passwordResetTokenHash: expect.any(String),
            passwordResetTokenExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com' }));
    });
  });

  describe('resetPassword', () => {
    it('rejects an unknown or expired token', async () => {
      prisma.adminUser.findFirst.mockResolvedValue(null);
      await expect(service.resetPassword('bad-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token past its expiry', async () => {
      prisma.adminUser.findFirst.mockResolvedValue({
        id: 'admin-1',
        passwordResetTokenExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resetPassword('expired-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('hashes the new password, clears the token, and revokes all sessions', async () => {
      prisma.adminUser.findFirst.mockResolvedValue({
        id: 'admin-1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      });

      await service.resetPassword('good-token', 'new-password-123');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          passwordHash: expect.any(String),
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('ADMIN', 'admin-1', 'password_reset');
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash });

      await expect(
        service.changePassword('admin-1', 'wrong-password', 'new-password-123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });

    it('hashes the new password without revoking sessions', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash });

      await service.changePassword('admin-1', 'correct-password', 'new-password-123');

      const updateCall = prisma.adminUser.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'admin-1' });
      expect(updateCall.data.passwordHash).not.toBe(passwordHash);
      expect(sessionService.revokeAllForPrincipal).not.toHaveBeenCalled();
    });
  });

  describe('setupTwoFactor', () => {
    it('throws ConflictException when 2FA is already enabled', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', twoFactorEnabled: true });
      await expect(service.setupTwoFactor('admin-1', 'TOTP')).rejects.toThrow(ConflictException);
    });

    it('generates a TOTP secret and otpauth URL, storing the secret as pending', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('admin-1', 'TOTP');

      expect(result.method).toBe('TOTP');
      expect(result.secret).toEqual(expect.any(String));
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({ twoFactorPendingMethod: 'TOTP', twoFactorPendingSecret: result.secret }),
        }),
      );
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates and emails a code for the email method, without returning a secret', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        email: 'admin@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('admin-1', 'EMAIL');

      expect(result).toEqual({ method: 'EMAIL' });
      expect(prisma.adminUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'admin-1' },
          data: expect.objectContaining({
            twoFactorPendingMethod: 'EMAIL',
            twoFactorEmailCodeHash: expect.any(String),
            twoFactorEmailCodeExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'admin@example.com' }));
    });
  });

  describe('confirmTwoFactor', () => {
    it('throws ConflictException when no setup is in progress', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', twoFactorPendingMethod: null });
      await expect(service.confirmTwoFactor('admin-1', '123456')).rejects.toThrow(ConflictException);
    });

    it('rejects an invalid TOTP code without enabling 2FA', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: false });

      await expect(service.confirmTwoFactor('admin-1', 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('activates TOTP on a valid code', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });

      await service.confirmTwoFactor('admin-1', '123456');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: 'TOTP',
          twoFactorSecret: 'SOMESECRET',
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
        },
      });
    });

    it('rejects an invalid/expired email code', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: 'a-different-hash',
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await expect(service.confirmTwoFactor('admin-1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('activates email 2FA on a matching code', async () => {
      const { hashToken } = jest.requireActual('../../common/opaque-token.util');
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        id: 'admin-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: hashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await service.confirmTwoFactor('admin-1', '123456');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: 'EMAIL',
          twoFactorPendingMethod: null,
          twoFactorEmailCodeHash: null,
          twoFactorEmailCodeExpiresAt: null,
        },
      });
    });
  });

  describe('disableTwoFactor', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash, twoFactorEnabled: true });

      await expect(service.disableTwoFactor('admin-1', 'wrong-password')).rejects.toThrow(UnauthorizedException);
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when 2FA is not enabled', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash, twoFactorEnabled: false });

      await expect(service.disableTwoFactor('admin-1', 'correct-password')).rejects.toThrow(ConflictException);
    });

    it('clears all two-factor fields on success', async () => {
      const passwordHash = await bcrypt.hash('correct-password', 12);
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({ id: 'admin-1', passwordHash, twoFactorEnabled: true });

      await service.disableTwoFactor('admin-1', 'correct-password');

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: {
          twoFactorEnabled: false,
          twoFactorMethod: null,
          twoFactorSecret: null,
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
          twoFactorEmailCodeHash: null,
          twoFactorEmailCodeExpiresAt: null,
        },
      });
    });
  });
});

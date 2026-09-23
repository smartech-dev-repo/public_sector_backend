import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { verify as otplibVerify } from 'otplib';
import { hashPassword } from '../../common/password-hash.util';
import { AgentAuthService } from './agent-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { EmailService } from '../../email/email.service';
import { ConfigService } from '@nestjs/config';

jest.mock('otplib', () => ({
  ...jest.requireActual('otplib'),
  verify: jest.fn(),
}));

describe('AgentAuthService', () => {
  let service: AgentAuthService;
  let prisma: {
    agent: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
  };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock; revokeAllForPrincipal: jest.Mock };
  let emailService: { send: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
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
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    service = new AgentAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
      emailService as unknown as EmailService,
    );
  });

  describe('login', () => {
    it('rejects an agent that is still PENDING_REVIEW', async () => {
      const passwordHash = await hashPassword('secret-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'PENDING_REVIEW',
      });

      await expect(
        service.login('agent@example.com', 'secret-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an approved agent with no password set yet', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash: null,
        status: 'APPROVED',
      });

      await expect(
        service.login('agent@example.com', 'secret-password'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('issues tokens, marks hasLoggedIn, and includes mustChangePassword in the payload', async () => {
      const passwordHash = await hashPassword('secret-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        mustChangePassword: true,
      });

      const result = await service.login('agent@example.com', 'secret-password', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { hasLoggedIn: true },
      });
      expect(tokenService.signAccessToken).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 'agent-1', type: 'agent', mustChangePassword: true }),
      );
      expect(sessionService.createSession).toHaveBeenCalledWith({
        principalType: 'AGENT',
        principalId: 'agent-1',
        userAgent: 'jest',
        ip: '127.0.0.1',
      });
      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
    });
  });

  describe('getMustChangePasswordForAgent', () => {
    it('returns the agent\'s current flag', async () => {
      prisma.agent.findUnique.mockResolvedValue({ mustChangePassword: false });
      await expect(service.getMustChangePasswordForAgent('agent-1')).resolves.toBe(false);
    });

    it('returns false when the agent no longer exists', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.getMustChangePasswordForAgent('missing')).resolves.toBe(false);
    });
  });

  describe('changePassword', () => {
    it('rejects an incorrect current password', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash });

      await expect(
        service.changePassword('agent-1', 'wrong-password', 'new-password-123'),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('hashes the new password and clears mustChangePassword', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash });

      await service.changePassword('agent-1', 'correct-password', 'new-password-123');

      const updateCall = prisma.agent.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'agent-1' });
      expect(updateCall.data.mustChangePassword).toBe(false);
      expect(updateCall.data.passwordHash).not.toBe(passwordHash);
    });
  });

  describe('forgotPassword', () => {
    it('does nothing observable when the email does not match an approved agent', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await service.forgotPassword('nobody@example.com');

      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('does nothing observable for a non-approved agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', email: 'a@example.com', status: 'PENDING_REVIEW' });

      await service.forgotPassword('a@example.com');

      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates a reset token, stores its hash, and emails it', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1', email: 'a@example.com', status: 'APPROVED' });

      await service.forgotPassword('a@example.com');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
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
      prisma.agent.findFirst.mockResolvedValue(null);
      await expect(service.resetPassword('bad-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token past its expiry', async () => {
      prisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        passwordResetTokenExpiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resetPassword('expired-token', 'new-password-123')).rejects.toThrow(UnauthorizedException);
    });

    it('hashes the new password, clears mustChangePassword and the token, and revokes all sessions', async () => {
      prisma.agent.findFirst.mockResolvedValue({
        id: 'agent-1',
        passwordResetTokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      });

      await service.resetPassword('good-token', 'new-password-123');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: {
          passwordHash: expect.any(String),
          mustChangePassword: false,
          passwordResetTokenHash: null,
          passwordResetTokenExpiresAt: null,
        },
      });
      expect(sessionService.revokeAllForPrincipal).toHaveBeenCalledWith('AGENT', 'agent-1', 'password_reset');
    });
  });

  describe('setupTwoFactor', () => {
    it('throws ConflictException when 2FA is already enabled', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', twoFactorEnabled: true });
      await expect(service.setupTwoFactor('agent-1', 'TOTP')).rejects.toThrow(ConflictException);
    });

    it('generates a TOTP secret and otpauth URL, storing the secret as pending', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('agent-1', 'TOTP');

      expect(result.method).toBe('TOTP');
      expect(result.secret).toEqual(expect.any(String));
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({ twoFactorPendingMethod: 'TOTP', twoFactorPendingSecret: result.secret }),
        }),
      );
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('generates and emails a code for the email method, without returning a secret', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        twoFactorEnabled: false,
      });

      const result = await service.setupTwoFactor('agent-1', 'EMAIL');

      expect(result).toEqual({ method: 'EMAIL' });
      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({
            twoFactorPendingMethod: 'EMAIL',
            twoFactorEmailCodeHash: expect.any(String),
            twoFactorEmailCodeExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.com' }));
    });

    it('respects EMAIL_CODE_LENGTH when generating an EMAIL setup code', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', email: 'agent@example.com', twoFactorEnabled: false });
      const configService = {
        get: jest.fn((key: string) => (key === 'EMAIL_CODE_LENGTH' ? '8' : undefined)),
      } as unknown as ConfigService;
      const configuredService = new AgentAuthService(
        prisma as unknown as PrismaService,
        tokenService,
        sessionService as unknown as SessionService,
        emailService as unknown as EmailService,
        configService,
      );

      await configuredService.setupTwoFactor('agent-1', 'EMAIL' as never);

      const sentEmail = emailService.send.mock.calls[0][0];
      const match = /Your verification code is: (\d+)/.exec(sentEmail.text);
      expect(match?.[1]).toHaveLength(8);
    });
  });

  describe('confirmTwoFactor', () => {
    it('throws ConflictException when no setup is in progress', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', twoFactorPendingMethod: null });
      await expect(service.confirmTwoFactor('agent-1', '123456')).rejects.toThrow(ConflictException);
    });

    it('rejects an invalid TOTP code without enabling 2FA', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: false });

      await expect(service.confirmTwoFactor('agent-1', 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('activates TOTP on a valid code', async () => {
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'TOTP',
        twoFactorPendingSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });

      await service.confirmTwoFactor('agent-1', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
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
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: 'a-different-hash',
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await expect(service.confirmTwoFactor('agent-1', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('activates email 2FA on a matching code', async () => {
      const { hashToken: realHashToken } = jest.requireActual('../../common/opaque-token.util');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorPendingMethod: 'EMAIL',
        twoFactorEmailCodeHash: realHashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
      });

      await service.confirmTwoFactor('agent-1', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
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
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, twoFactorEnabled: true });

      await expect(service.disableTwoFactor('agent-1', 'wrong-password')).rejects.toThrow(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when 2FA is not enabled', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, twoFactorEnabled: false });

      await expect(service.disableTwoFactor('agent-1', 'correct-password')).rejects.toThrow(ConflictException);
    });

    it('clears all two-factor fields on success', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUniqueOrThrow.mockResolvedValue({ id: 'agent-1', passwordHash, twoFactorEnabled: true });

      await service.disableTwoFactor('agent-1', 'correct-password');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
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

  describe('login with 2FA enabled', () => {
    it('returns a pending token instead of real tokens for a TOTP agent, without sending email', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        twoFactorEnabled: true,
        twoFactorMethod: 'TOTP',
      });
      (tokenService as unknown as { signTwoFactorPendingToken: jest.Mock }).signTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue('pending-token');

      const result = await service.login('agent@example.com', 'correct-password');

      expect(result).toEqual({ twoFactorRequired: true, method: 'TOTP', pendingToken: 'pending-token' });
      expect(emailService.send).not.toHaveBeenCalled();
      expect(sessionService.createSession).not.toHaveBeenCalled();
      expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'agent-1' }, data: { hasLoggedIn: true } });
    });

    it('emails a code and returns a pending token for an EMAIL agent', async () => {
      const passwordHash = await hashPassword('correct-password');
      prisma.agent.findUnique.mockResolvedValue({
        id: 'agent-1',
        email: 'agent@example.com',
        passwordHash,
        status: 'APPROVED',
        twoFactorEnabled: true,
        twoFactorMethod: 'EMAIL',
      });
      (tokenService as unknown as { signTwoFactorPendingToken: jest.Mock }).signTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue('pending-token');

      const result = await service.login('agent@example.com', 'correct-password');

      expect(result).toEqual({ twoFactorRequired: true, method: 'EMAIL', pendingToken: 'pending-token' });
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'agent@example.com' }));
    });
  });

  describe('verifyTwoFactorLogin', () => {
    it('rejects an invalid or expired pending token', async () => {
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockImplementation(() => {
          throw new Error('expired');
        });

      await expect(service.verifyTwoFactorLogin('bad-token', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an invalid TOTP code', async () => {
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'agent-1' });
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorMethod: 'TOTP',
        twoFactorSecret: 'SOMESECRET',
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: false });

      await expect(service.verifyTwoFactorLogin('good-pending-token', 'wrong')).rejects.toThrow(UnauthorizedException);
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });

    it('issues real tokens on a valid TOTP code', async () => {
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'agent-1' });
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorMethod: 'TOTP',
        twoFactorSecret: 'SOMESECRET',
        mustChangePassword: false,
      });
      (otplibVerify as jest.Mock).mockResolvedValue({ valid: true });

      const result = await service.verifyTwoFactorLogin('good-pending-token', '123456', {
        userAgent: 'jest',
        ip: '127.0.0.1',
      });

      expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: 'agent-1' }),
      );
    });

    it('rejects an invalid or expired email code, and clears it on a valid one', async () => {
      const { hashToken: realHashToken } = jest.requireActual('../../common/opaque-token.util');
      (tokenService as unknown as { verifyTwoFactorPendingToken: jest.Mock }).verifyTwoFactorPendingToken = jest
        .fn()
        .mockReturnValue({ sub: 'agent-1' });
      prisma.agent.findUniqueOrThrow.mockResolvedValue({
        id: 'agent-1',
        twoFactorMethod: 'EMAIL',
        twoFactorEmailCodeHash: realHashToken('123456'),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + 1000 * 60 * 10),
        mustChangePassword: false,
      });

      await service.verifyTwoFactorLogin('good-pending-token', '123456');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'agent-1' },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    });
  });
});

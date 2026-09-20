import { UnauthorizedException } from '@nestjs/common';
import { hashPassword } from '../../common/password-hash.util';
import { AgentAuthService } from './agent-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('AgentAuthService', () => {
  let service: AgentAuthService;
  let prisma: { agent: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    tokenService = {
      signAccessToken: jest.fn().mockReturnValue('access-token'),
    } as unknown as TokenService;
    sessionService = { createSession: jest.fn().mockResolvedValue('refresh-token') };
    service = new AgentAuthService(
      prisma as unknown as PrismaService,
      tokenService,
      sessionService as unknown as SessionService,
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
});

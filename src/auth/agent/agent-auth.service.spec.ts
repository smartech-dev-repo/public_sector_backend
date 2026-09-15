import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AgentAuthService } from './agent-auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';

describe('AgentAuthService', () => {
  let service: AgentAuthService;
  let prisma: { agent: { findUnique: jest.Mock } };
  let tokenService: TokenService;
  let sessionService: { createSession: jest.Mock };

  beforeEach(() => {
    prisma = { agent: { findUnique: jest.fn() } };
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

  it('rejects an agent that is still PENDING_REVIEW', async () => {
    const passwordHash = await bcrypt.hash('secret-password', 12);
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

  it('issues tokens via SessionService for an approved agent with the right password', async () => {
    const passwordHash = await bcrypt.hash('secret-password', 12);
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      passwordHash,
      status: 'APPROVED',
    });

    const result = await service.login('agent@example.com', 'secret-password', {
      userAgent: 'jest',
      ip: '127.0.0.1',
    });

    expect(sessionService.createSession).toHaveBeenCalledWith({
      principalType: 'AGENT',
      principalId: 'agent-1',
      userAgent: 'jest',
      ip: '127.0.0.1',
    });
    expect(result).toEqual({ accessToken: 'access-token', refreshToken: 'refresh-token' });
  });
});

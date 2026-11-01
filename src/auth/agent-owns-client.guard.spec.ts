import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { AgentOwnsClientGuard } from './agent-owns-client.guard';
import { AuditLogService } from '../audit/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

const context = () =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        params: { clientId: 'client-1' },
        user: { sub: 'agent-1', type: 'agent' },
        headers: { 'user-agent': 'jest' },
        ip: '10.0.0.1',
        route: { path: '/agent/clients/:clientId/onboarding/status' },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('AgentOwnsClientGuard', () => {
  let prisma: { client: { findFirst: jest.Mock } };
  let auditLogService: { recordSafely: jest.Mock };
  let guard: AgentOwnsClientGuard;

  beforeEach(() => {
    prisma = { client: { findFirst: jest.fn() } };
    auditLogService = { recordSafely: jest.fn().mockResolvedValue(undefined) };
    guard = new AgentOwnsClientGuard(prisma as unknown as PrismaService, auditLogService as unknown as AuditLogService);
  });

  it('allows the agent who onboarded the client, and logs nothing', async () => {
    prisma.client.findFirst.mockResolvedValue({ id: 'client-1' });

    await expect(guard.canActivate(context())).resolves.toBe(true);

    expect(prisma.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-1', onboarding: { onboardedByAgentId: 'agent-1' } },
      select: { id: true },
    });
    expect(auditLogService.recordSafely).not.toHaveBeenCalled();
  });

  it('answers 404 for another agent and records the attempt', async () => {
    prisma.client.findFirst.mockResolvedValue(null);

    await expect(guard.canActivate(context())).rejects.toThrow(NotFoundException);

    expect(auditLogService.recordSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.client_access.denied',
        actorId: 'agent-1',
        targetId: 'client-1',
        ip: '10.0.0.1',
        userAgent: 'jest',
      }),
    );
  });
});

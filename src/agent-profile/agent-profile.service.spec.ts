// src/agent-profile/agent-profile.service.spec.ts
import { AgentProfileService } from './agent-profile.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AgentProfileService', () => {
  let service: AgentProfileService;
  let prisma: { agent: { findUniqueOrThrow: jest.Mock } };

  beforeEach(() => {
    prisma = { agent: { findUniqueOrThrow: jest.fn() } };
    service = new AgentProfileService(prisma as unknown as PrismaService);
  });

  it('returns the whitelisted profile fields including the resolved reviewer, excluding passwordHash', async () => {
    prisma.agent.findUniqueOrThrow.mockResolvedValue({
      id: 'agent-1',
      email: 'agent@example.com',
      phone: '+2348000000000',
      fullName: 'Agent Smith',
      address: '1 Example Street',
      status: 'APPROVED',
      canOnboardClients: true,
      mustChangePassword: false,
      hasLoggedIn: true,
      reviewedByAdmin: { id: 'admin-1', fullName: 'Super Admin', email: 'admin@example.com' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      passwordHash: 'should-not-leak',
    });

    const result = await service.getProfile('agent-1');

    expect(result).toEqual({
      id: 'agent-1',
      email: 'agent@example.com',
      phone: '+2348000000000',
      fullName: 'Agent Smith',
      address: '1 Example Street',
      status: 'APPROVED',
      canOnboardClients: true,
      mustChangePassword: false,
      hasLoggedIn: true,
      reviewedByAdmin: { id: 'admin-1', fullName: 'Super Admin', email: 'admin@example.com' },
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
    });
    expect(result).not.toHaveProperty('passwordHash');
  });
});

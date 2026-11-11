import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ClientAssignmentService } from './client-assignment.service';
import { SmsType } from '../sms/sms-type';

describe('ClientAssignmentService.requestAgentLink', () => {
  const client = { id: 'client-1', phone: '+2348031234567', assignedAgentId: null as string | null };
  let prisma: {
    client: { findUnique: jest.Mock; findFirst: jest.Mock };
    agent: { findUniqueOrThrow: jest.Mock };
    clientLinkRequest: { create: jest.Mock };
  };
  let sms: { send: jest.Mock };
  let service: ClientAssignmentService;

  beforeEach(() => {
    prisma = {
      client: { findUnique: jest.fn().mockResolvedValue(client), findFirst: jest.fn().mockResolvedValue(client) },
      agent: { findUniqueOrThrow: jest.fn().mockResolvedValue({ fullName: 'Ada Agent' }) },
      clientLinkRequest: {
        create: jest.fn().mockResolvedValue({ id: 'req-1', expiresAt: new Date('2026-11-11T12:15:00Z') }),
      },
    };
    sms = { send: jest.fn().mockResolvedValue(undefined) };
    const audit = { recordSafely: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    service = new ClientAssignmentService(prisma as never, audit as never, sms as never, {} as never, {} as never, config as never);
  });

  it('finds the client by IPPIS number, ignoring case and spaces, and texts the code to their app phone', async () => {
    const result = await service.requestAgentLink('agent-1', { ippisNumber: '  pf02254698 ' });

    expect(prisma.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { onboarding: { ippisRecord: { staffId: { equals: 'pf02254698', mode: 'insensitive' } } } },
      }),
    );
    expect(prisma.client.findUnique).not.toHaveBeenCalled();
    expect(sms.send).toHaveBeenCalledWith(expect.objectContaining({ type: SmsType.OTP, phone: client.phone }));
    expect(result).toMatchObject({ requestId: 'req-1', sentTo: '+234•••••567' });
    expect(result).not.toHaveProperty('devCode');
  });

  it('an unknown IPPIS number is a 404 asking the agent to onboard them', async () => {
    prisma.client.findFirst.mockResolvedValue(null);
    await expect(service.requestAgentLink('agent-1', { ippisNumber: 'PF00000000' })).rejects.toThrow(
      new NotFoundException('No client found. If they are new, onboard them instead.'),
    );
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('a client already linked to another agent is refused before any code is sent', async () => {
    prisma.client.findFirst.mockResolvedValue({ ...client, assignedAgentId: 'agent-2' });
    await expect(service.requestAgentLink('agent-1', { ippisNumber: 'PF02254698' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('needs a phone number or an IPPIS number', async () => {
    await expect(service.requestAgentLink('agent-1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
});

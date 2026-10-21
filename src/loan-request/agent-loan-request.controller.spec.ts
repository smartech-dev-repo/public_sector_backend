import { NotFoundException } from '@nestjs/common';
import { AgentLoanRequestController } from './agent-loan-request.controller';
import { PrismaService } from '../prisma/prisma.service';
import { LoanRequestService } from './loan-request.service';
import { JwtPayload } from '../auth/jwt-payload.interface';

describe('AgentLoanRequestController', () => {
  let controller: AgentLoanRequestController;
  let prisma: { client: { findFirst: jest.Mock } };
  let loanRequestService: {
    create: jest.Mock;
    createTopup: jest.Mock;
    resend: jest.Mock;
    confirmByCode: jest.Mock;
  };
  const agentReq = { user: { sub: 'agent-1', type: 'agent' } as JwtPayload };

  beforeEach(() => {
    prisma = { client: { findFirst: jest.fn() } };
    loanRequestService = {
      create: jest.fn(),
      createTopup: jest.fn(),
      resend: jest.fn(),
      confirmByCode: jest.fn(),
    };
    controller = new AgentLoanRequestController(
      prisma as unknown as PrismaService,
      loanRequestService as unknown as LoanRequestService,
    );
  });

  describe('create', () => {
    it('throws NotFoundException when the agent does not own the client', async () => {
      prisma.client.findFirst.mockResolvedValue(null);
      await expect(controller.create('client-1', { amount: 5000, tenorMonths: 6 }, agentReq)).rejects.toThrow(
        NotFoundException,
      );
      expect(loanRequestService.create).not.toHaveBeenCalled();
    });

    it('delegates to LoanRequestService.create with the clientId, not the agent id', async () => {
      prisma.client.findFirst.mockResolvedValue({ id: 'client-1' });
      loanRequestService.create.mockResolvedValue({ id: 'lr1' });

      await controller.create('client-1', { amount: 5000, tenorMonths: 6 }, agentReq);

      expect(prisma.client.findFirst).toHaveBeenCalledWith({
        where: { id: 'client-1', onboarding: { onboardedByAgentId: 'agent-1' } },
        select: { id: true },
      });
      expect(loanRequestService.create).toHaveBeenCalledWith('client-1', 5000, 6);
    });
  });

  describe('createTopup', () => {
    it('throws NotFoundException when the agent does not own the client', async () => {
      prisma.client.findFirst.mockResolvedValue(null);
      await expect(
        controller.createTopup('client-1', { amount: 5000, tenorMonths: 6 }, agentReq),
      ).rejects.toThrow(NotFoundException);
      expect(loanRequestService.createTopup).not.toHaveBeenCalled();
    });

    it('delegates to LoanRequestService.createTopup with the clientId', async () => {
      prisma.client.findFirst.mockResolvedValue({ id: 'client-1' });
      loanRequestService.createTopup.mockResolvedValue({ id: 'lr2' });

      await controller.createTopup('client-1', { amount: 5000, tenorMonths: 6 }, agentReq);

      expect(loanRequestService.createTopup).toHaveBeenCalledWith('client-1', 5000, 6);
    });
  });

  describe('resend', () => {
    it('throws NotFoundException when the agent does not own the client', async () => {
      prisma.client.findFirst.mockResolvedValue(null);
      await expect(controller.resend('client-1', 'lr1', agentReq)).rejects.toThrow(NotFoundException);
      expect(loanRequestService.resend).not.toHaveBeenCalled();
    });

    it('delegates to LoanRequestService.resend with the clientId', async () => {
      prisma.client.findFirst.mockResolvedValue({ id: 'client-1' });
      loanRequestService.resend.mockResolvedValue({ id: 'lr1' });

      await controller.resend('client-1', 'lr1', agentReq);

      expect(loanRequestService.resend).toHaveBeenCalledWith('client-1', 'lr1');
    });
  });

  describe('confirmCode', () => {
    it('throws NotFoundException when the agent does not own the client', async () => {
      prisma.client.findFirst.mockResolvedValue(null);
      await expect(controller.confirmCode('client-1', 'lr1', { code: '123456' }, agentReq)).rejects.toThrow(
        NotFoundException,
      );
      expect(loanRequestService.confirmByCode).not.toHaveBeenCalled();
    });

    it('delegates to LoanRequestService.confirmByCode with the clientId and returns { confirmed: true }', async () => {
      prisma.client.findFirst.mockResolvedValue({ id: 'client-1' });
      loanRequestService.confirmByCode.mockResolvedValue(undefined);

      const result = await controller.confirmCode('client-1', 'lr1', { code: '123456' }, agentReq);

      expect(loanRequestService.confirmByCode).toHaveBeenCalledWith('client-1', 'lr1', '123456');
      expect(result).toEqual({ confirmed: true });
    });
  });
});

import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';

describe('AdminAgentReviewService', () => {
  let service: AdminAgentReviewService;
  let prisma: { agent: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock } };
  let emailService: { send: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    configService = { get: jest.fn().mockReturnValue(undefined) };
    service = new AdminAgentReviewService(
      prisma as unknown as PrismaService,
      emailService as unknown as EmailService,
      configService as unknown as ConfigService,
    );
  });

  describe('approve', () => {
    it('throws NotFoundException when the agent does not exist', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.approve('missing-id', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when the agent is not PENDING_REVIEW', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'APPROVED', email: 'a@example.com' });
      await expect(service.approve('a1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('generates credentials, sets APPROVED, and emails the agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.approve('a1', 'admin-1');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'a1' },
          data: expect.objectContaining({
            mustChangePassword: true,
            status: 'APPROVED',
            reviewedBy: 'admin-1',
          }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@example.com', subject: expect.any(String) }),
      );
    });

    it('omits the app download link when AGENT_APP_DOWNLOAD_URL is not configured', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.approve('a1', 'admin-1');

      const sentMessage = emailService.send.mock.calls[0][0];
      expect(sentMessage.text).not.toMatch(/Download the app/);
    });

    it('includes the app download link when AGENT_APP_DOWNLOAD_URL is configured', async () => {
      configService.get.mockReturnValue('https://example.com/download');
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.approve('a1', 'admin-1');

      const sentMessage = emailService.send.mock.calls[0][0];
      expect(sentMessage.text).toContain('https://example.com/download');
    });
  });

  describe('reject', () => {
    it('throws ConflictException when the agent is not PENDING_REVIEW', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'REJECTED' });
      await expect(service.reject('a1', 'admin-1', 'Incomplete CV')).rejects.toThrow(ConflictException);
    });

    it('sets REJECTED with the reason and reviewer, and sends no email', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW' });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.reject('a1', 'admin-1', 'Incomplete CV');

      expect(prisma.agent.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: {
          status: 'REJECTED',
          rejectionReason: 'Incomplete CV',
          reviewedBy: 'admin-1',
          reviewedAt: expect.any(Date),
        },
      });
      expect(emailService.send).not.toHaveBeenCalled();
    });
  });

  describe('resendCredentials', () => {
    it('throws ConflictException when the agent is not APPROVED', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', hasLoggedIn: false });
      await expect(service.resendCredentials('a1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when the agent has already logged in', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'APPROVED', hasLoggedIn: true });
      await expect(service.resendCredentials('a1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('regenerates credentials and re-sends the email when still unused', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a1',
        status: 'APPROVED',
        hasLoggedIn: false,
        email: 'a@example.com',
      });
      prisma.agent.update.mockResolvedValue({ id: 'a1' });

      await service.resendCredentials('a1', 'admin-1');

      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: true }) }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@example.com' }));
    });
  });
});

import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AgentStatus } from '../generated/prisma/client';

describe('AdminAgentReviewService', () => {
  let service: AdminAgentReviewService;
  let prisma: { agent: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; count: jest.Mock } };
  let emailService: { send: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
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

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('includes reviewedByAdmin', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a1',
        status: 'APPROVED',
        reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' },
      });

      const result = await service.findById('a1');

      expect(prisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'a1' },
        include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
      });
      expect(result.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
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

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 25 }));
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches fullName/email/phone', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      await service.list({ status: AgentStatus.APPROVED, q: 'okoro' });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: AgentStatus.APPROVED,
            OR: [
              { fullName: { contains: 'okoro', mode: 'insensitive' } },
              { email: { contains: 'okoro', mode: 'insensitive' } },
              { phone: { contains: 'okoro', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies createdAt and reviewedAt date ranges independently', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const reviewedTo = new Date('2025-06-01');

      await service.list({ createdFrom, reviewedTo });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: createdFrom, lte: undefined },
            reviewedAt: { gte: undefined, lte: reviewedTo },
          }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(9);

      const result = await service.list({}, { page: 2, limit: 4 });

      expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 4, take: 4 }));
      expect(result.meta).toEqual({ total: 9, page: 2, limit: 4, totalPages: 3 });
    });

    it('includes reviewedByAdmin on every row', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);

      await service.list();

      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
        }),
      );
    });
  });
});

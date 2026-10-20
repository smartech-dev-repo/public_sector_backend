import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAgentReviewService } from './admin-agent-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { AgentStatus } from '../generated/prisma/client';

describe('AdminAgentReviewService', () => {
  let service: AdminAgentReviewService;
  let prisma: { agent: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; count: jest.Mock } };
  let emailService: { send: jest.Mock };
  let configService: { get: jest.Mock };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn() },
    };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    configService = { get: jest.fn().mockReturnValue(undefined) };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn((key: string) => Promise.resolve(`https://storage.example.com/${key}`)) };
    service = new AdminAgentReviewService(
      prisma as unknown as PrismaService,
      emailService as unknown as EmailService,
      configService as unknown as ConfigService,
      fileStorageProvider as unknown as FileStorageProvider,
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

  describe('setOnboardingAccess', () => {
    it('throws NotFoundException when the agent does not exist', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      await expect(service.setOnboardingAccess('missing', true)).rejects.toThrow(NotFoundException);
    });

    it('rejects enabling access for a non-APPROVED agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW' });
      await expect(service.setOnboardingAccess('a1', true)).rejects.toThrow(UnprocessableEntityException);
    });

    it('allows disabling access regardless of status', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW' });
      prisma.agent.update.mockResolvedValue({ id: 'a1', canOnboardClients: false });

      await service.setOnboardingAccess('a1', false);

      expect(prisma.agent.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { canOnboardClients: false } });
    });

    it('enables access for an APPROVED agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'APPROVED' });
      prisma.agent.update.mockResolvedValue({ id: 'a1', canOnboardClients: true });

      const result = await service.setOnboardingAccess('a1', true);

      expect(result.canOnboardClients).toBe(true);
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
        cvKey: null,
        passportPhotoKey: null,
        identityDocumentKey: null,
        supportingDocumentKeys: [],
        reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' },
      });

      const result = await service.findById('a1');

      expect(prisma.agent.findUnique).toHaveBeenCalledWith({
        where: { id: 'a1' },
        include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
      });
      expect(result.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });

    it('resolves signed URLs for every stored document key, leaving the raw keys in place', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a1',
        status: 'APPROVED',
        cvKey: 'agents/a1/cv.pdf',
        passportPhotoKey: 'agents/a1/passport.jpg',
        identityDocumentKey: 'agents/a1/id.pdf',
        supportingDocumentKeys: ['agents/a1/extra1.pdf', 'agents/a1/extra2.pdf'],
      });

      const result = await service.findById('a1');

      expect(result.cvKey).toBe('agents/a1/cv.pdf');
      expect(result.cvUrl).toBe('https://storage.example.com/agents/a1/cv.pdf');
      expect(result.passportPhotoUrl).toBe('https://storage.example.com/agents/a1/passport.jpg');
      expect(result.identityDocumentUrl).toBe('https://storage.example.com/agents/a1/id.pdf');
      expect(result.supportingDocumentUrls).toEqual([
        'https://storage.example.com/agents/a1/extra1.pdf',
        'https://storage.example.com/agents/a1/extra2.pdf',
      ]);
    });

    it('returns null document URLs when the corresponding key is null, without calling the storage provider for them', async () => {
      prisma.agent.findUnique.mockResolvedValue({
        id: 'a1',
        status: 'PENDING_REVIEW',
        cvKey: null,
        passportPhotoKey: null,
        identityDocumentKey: null,
        supportingDocumentKeys: [],
      });

      const result = await service.findById('a1');

      expect(result.cvUrl).toBeNull();
      expect(result.passportPhotoUrl).toBeNull();
      expect(result.identityDocumentUrl).toBeNull();
      expect(result.supportingDocumentUrls).toEqual([]);
      expect(fileStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('throws ConflictException when the agent is not PENDING_REVIEW', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'REJECTED' });
      await expect(service.reject('a1', 'admin-1', 'Incomplete CV')).rejects.toThrow(ConflictException);
    });

    it('sets REJECTED with the reason and reviewer, and emails the agent', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'a1', status: 'PENDING_REVIEW', email: 'a@example.com' });
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
      expect(emailService.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'a@example.com', text: expect.stringContaining('Incomplete CV') }),
      );
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

    it('resolves document URLs for every row', async () => {
      prisma.agent.findMany.mockResolvedValue([
        {
          id: 'a1',
          cvKey: 'agents/a1/cv.pdf',
          passportPhotoKey: null,
          identityDocumentKey: null,
          supportingDocumentKeys: [],
        },
      ]);
      prisma.agent.count.mockResolvedValue(1);

      const result = await service.list();

      expect(result.data[0].cvUrl).toBe('https://storage.example.com/agents/a1/cv.pdf');
    });
  });
});

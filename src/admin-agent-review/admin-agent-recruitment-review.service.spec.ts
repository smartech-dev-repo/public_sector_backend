import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminAgentRecruitmentReviewService } from './admin-agent-recruitment-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('AdminAgentRecruitmentReviewService', () => {
  let service: AdminAgentRecruitmentReviewService;
  let prisma: {
    agentApplication: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      groupBy: jest.Mock;
      delete: jest.Mock;
    };
  };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };

  const baseRow = {
    id: 'app-1',
    email: 'jane@example.com',
    status: 'EMAIL_VERIFIED',
    emailVerifiedAt: new Date('2026-01-01'),
    fullName: 'Jane Doe',
    phone: '+2348000000000',
    gender: 'Female',
    address: '1 St',
    city: 'Lagos',
    state: 'Lagos',
    localGovernment: 'Ikeja',
    nin: '12345678901',
    ninVerified: true,
    ninVerifiedName: 'Jane Doe',
    coverLetter: 'Hello',
    cvKey: null,
    passportPhotoKey: null,
    identityDocumentKey: null,
    submittedAgent: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(() => {
    prisma = {
      agentApplication: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
        delete: jest.fn(),
      },
    };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn((key: string) => Promise.resolve(`https://storage.example.com/${key}`)) };
    service = new AdminAgentRecruitmentReviewService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('list', () => {
    it('defaults to page 1/limit 25 with no filters', async () => {
      const result = await service.list();

      expect(prisma.agentApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: undefined, createdAt: undefined, OR: undefined }, skip: 0, take: 25 }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches email/fullName', async () => {
      await service.list({ status: 'SUBMITTED' as never, q: 'jane' });

      expect(prisma.agentApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'SUBMITTED',
            OR: [
              { email: { contains: 'jane', mode: 'insensitive' } },
              { fullName: { contains: 'jane', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });

    it('applies a createdAt date range', async () => {
      const createdFrom = new Date('2026-01-01');
      const createdTo = new Date('2026-12-31');

      await service.list({ createdFrom, createdTo });

      expect(prisma.agentApplication.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('narrows each row and includes a submittedAgent summary when present', async () => {
      prisma.agentApplication.findMany.mockResolvedValue([
        { ...baseRow, status: 'SUBMITTED', submittedAgent: { id: 'agent-1', status: 'PENDING_REVIEW' } },
      ]);
      prisma.agentApplication.count.mockResolvedValue(1);

      const result = await service.list();

      expect(result.data[0]).toEqual(
        expect.objectContaining({ id: 'app-1', submittedAgent: { id: 'agent-1', status: 'PENDING_REVIEW' } }),
      );
      expect(result.data[0]).not.toHaveProperty('emailCodeHash');
      expect(result.data[0]).not.toHaveProperty('emailCodeExpiresAt');
    });

    it('resolves document URLs for every row', async () => {
      prisma.agentApplication.findMany.mockResolvedValue([
        { ...baseRow, cvKey: 'agent-applications/app-1/cv.pdf' },
      ]);
      prisma.agentApplication.count.mockResolvedValue(1);

      const result = await service.list();

      expect(result.data[0].cvUrl).toBe('https://storage.example.com/agent-applications/app-1/cv.pdf');
    });
  });

  describe('findById', () => {
    it('throws NotFoundException when missing', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the narrowed shape when found', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(baseRow);
      const result = await service.findById('app-1');
      expect(result.id).toBe('app-1');
      expect(result.submittedAgent).toBeNull();
    });

    it('returns null document URLs when the keys are null, without calling the storage provider', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(baseRow);
      const result = await service.findById('app-1');
      expect(result.cvUrl).toBeNull();
      expect(result.passportPhotoUrl).toBeNull();
      expect(result.identityDocumentUrl).toBeNull();
      expect(fileStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('resolves signed URLs for every stored document key, leaving the raw keys in place', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        ...baseRow,
        cvKey: 'agent-applications/app-1/cv.pdf',
        passportPhotoKey: 'agent-applications/app-1/passport.jpg',
        identityDocumentKey: 'agent-applications/app-1/id.pdf',
      });

      const result = await service.findById('app-1');

      expect(result.cvKey).toBe('agent-applications/app-1/cv.pdf');
      expect(result.cvUrl).toBe('https://storage.example.com/agent-applications/app-1/cv.pdf');
      expect(result.passportPhotoUrl).toBe('https://storage.example.com/agent-applications/app-1/passport.jpg');
      expect(result.identityDocumentUrl).toBe('https://storage.example.com/agent-applications/app-1/id.pdf');
    });
  });

  describe('getAnalytics', () => {
    it('fills every AgentApplicationStatus key even when groupBy returns no rows', async () => {
      const result = await service.getAnalytics();
      expect(Object.keys(result.byStatus).sort()).toEqual(['EMAIL_PENDING', 'EMAIL_VERIFIED', 'SUBMITTED'].sort());
      expect(result.conversionRate).toBeNull();
      expect(result.averageTimeToSubmitHours).toBeNull();
    });

    it('computes conversionRate from submitted/total', async () => {
      prisma.agentApplication.count.mockResolvedValue(4);
      prisma.agentApplication.groupBy.mockResolvedValue([{ status: 'SUBMITTED', _count: { _all: 1 } }]);

      const result = await service.getAnalytics();

      expect(result.conversionRate).toBe(0.25);
    });

    it('computes averageTimeToSubmitHours across submitted rows', async () => {
      prisma.agentApplication.findMany.mockResolvedValue([
        {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          submittedAgent: { createdAt: new Date('2026-01-01T02:00:00Z') },
        },
        {
          createdAt: new Date('2026-01-01T00:00:00Z'),
          submittedAgent: { createdAt: new Date('2026-01-01T04:00:00Z') },
        },
      ]);

      const result = await service.getAnalytics();

      expect(result.averageTimeToSubmitHours).toBe(3);
    });
  });

  describe('remove', () => {
    it('throws NotFoundException when missing', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when already submitted', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'SUBMITTED' });
      await expect(service.remove('app-1')).rejects.toThrow(ConflictException);
      expect(prisma.agentApplication.delete).not.toHaveBeenCalled();
    });

    it('deletes a non-submitted draft', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'EMAIL_VERIFIED' });
      await service.remove('app-1');
      expect(prisma.agentApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-1' } });
    });
  });
});

import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminClientReviewService } from './admin-client-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClientOnboardingService } from '../client-onboarding/client-onboarding.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('AdminClientReviewService', () => {
  let service: AdminClientReviewService;
  let prisma: {
    client: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { update: jest.Mock };
  };
  let clientOnboardingService: { determineStepAfterIdentity: jest.Mock };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };

  beforeEach(() => {
    prisma = {
      client: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { update: jest.fn() },
    };
    clientOnboardingService = { determineStepAfterIdentity: jest.fn() };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn() };
    service = new AdminClientReviewService(
      prisma as unknown as PrismaService,
      clientOnboardingService as unknown as ClientOnboardingService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('list', () => {
    it('lists all clients with their onboarding record, defaulting to page 1/limit 25', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, phone: undefined, createdAt: undefined },
          include: { onboarding: true },
          skip: 0,
          take: 25,
        }),
      );
      expect(result.meta).toEqual({ total: 0, page: 1, limit: 25, totalPages: 0 });
    });

    it('filters by status and searches phone when given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ status: 'MANUAL_REVIEW' as never, q: '0801' });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'MANUAL_REVIEW',
            phone: { contains: '0801', mode: 'insensitive' },
          }),
        }),
      );
    });

    it('applies a createdAt date range', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);
      const createdFrom = new Date('2025-01-01');
      const createdTo = new Date('2025-12-31');

      await service.list({ createdFrom, createdTo });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ createdAt: { gte: createdFrom, lte: createdTo } }) }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(60);

      const result = await service.list({}, { page: 3, limit: 25 });

      expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 25 }));
      expect(result.meta).toEqual({ total: 60, page: 3, limit: 25, totalPages: 3 });
    });
  });

  describe('findById', () => {
    it('throws NotFoundException for an unknown id', async () => {
      prisma.client.findUnique.mockResolvedValue(null);
      await expect(service.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns the client with its onboarding record', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'MANUAL_REVIEW', onboarding: { id: 'o1' } });
      const result = await service.findById('c1');
      expect(result.id).toBe('c1');
    });

    it('resolves each document storageKey to a signed URL', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: {
          id: 'o1',
          documents: [
            { documentType: 'NIN_CARD', storageKey: 'client-onboarding/c1/documents/nin_card.jpg', uploadedAt: new Date('2026-01-01') },
          ],
        },
      });
      fileStorageProvider.getSignedDownloadUrl.mockResolvedValue('https://signed-url.example/nin_card.jpg');

      const result = await service.findById('c1');

      expect(fileStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'client-onboarding/c1/documents/nin_card.jpg',
      );
      expect(result.onboarding.documents).toEqual([
        { documentType: 'NIN_CARD', url: 'https://signed-url.example/nin_card.jpg', uploadedAt: new Date('2026-01-01') },
      ]);
    });

    it('does not fail when the client has no onboarding record', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'PHONE_VERIFIED', onboarding: null });
      const result = await service.findById('c1');
      expect(result.onboarding).toBeNull();
    });

    it('includes a computed lengthOfService from the linked IppisRecord', async () => {
      const now = new Date();
      const hireDate = new Date(now.getFullYear() - 1, now.getMonth(), 1);
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', ippisRecord: { hireDate } },
      });

      const result = await service.findById('c1');

      expect(prisma.client.findUnique).toHaveBeenCalledWith({
        where: { id: 'c1' },
        include: { onboarding: { include: { documents: true, ippisRecord: true } } },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
    });
  });

  describe('approve', () => {
    it('rejects when the client is not in MANUAL_REVIEW', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'VERIFIED', onboarding: { id: 'o1' } });
      await expect(service.approve('c1', 'admin-1')).rejects.toThrow(ConflictException);
    });

    it('marks the onboarding COMPLETED, records the reviewer, and sets Client VERIFIED', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'MANUAL_REVIEW', onboarding: { id: 'o1' } });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'VERIFIED' });

      await service.approve('c1', 'admin-1');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({ step: 'COMPLETED', reviewedBy: 'admin-1' }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'VERIFIED' },
      });
    });
  });

  describe('retry', () => {
    it('rejects when the client is not in MANUAL_REVIEW', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS', onboarding: { id: 'o1' } });
      await expect(service.retry('c1', 'admin-1', 'please retry')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client has no onboarding record', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'MANUAL_REVIEW', onboarding: null });
      await expect(service.retry('c1', 'admin-1', 'please retry')).rejects.toThrow(ConflictException);
    });

    it('resets to IPPIS_LINKED and clears identity+face fields when identity verification failed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', failureReasons: { identityVerified: false, faceMatchPassed: false } },
      });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS' });

      await service.retry('c1', 'admin-1', 'bad bvn, please resubmit');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({
          step: 'IPPIS_LINKED',
          bvn: null,
          nin: null,
          bvnSelfie: null,
          ninSelfie: null,
          identityVerified: null,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
          failureReasons: null,
          reviewedBy: 'admin-1',
          reviewNote: 'bad bvn, please resubmit',
        }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { status: 'PENDING_IPPIS' },
      });
    });

    it('resets to IDENTITY_SUBMITTED and only clears face-match fields when only the face match failed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', failureReasons: { identityVerified: true, faceMatchPassed: false } },
      });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS' });
      clientOnboardingService.determineStepAfterIdentity.mockResolvedValue('IDENTITY_SUBMITTED');

      await service.retry('c1', 'admin-1', 'blurry selfie, please retake');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({
          step: 'IDENTITY_SUBMITTED',
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
          failureReasons: null,
        }),
      });
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bvn: null }) }),
      );
    });

    it('skips straight to DOCUMENTS_SUBMITTED when the client already has all 4 documents, on a face-match-only retry', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: { id: 'o1', failureReasons: { identityVerified: true, faceMatchPassed: false } },
      });
      prisma.client.update.mockResolvedValue({ id: 'c1', status: 'PENDING_IPPIS' });
      clientOnboardingService.determineStepAfterIdentity.mockResolvedValue('DOCUMENTS_SUBMITTED');

      await service.retry('c1', 'admin-1', 'blurry selfie, please retake');

      expect(clientOnboardingService.determineStepAfterIdentity).toHaveBeenCalledWith('o1');
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'c1' },
        data: expect.objectContaining({ step: 'DOCUMENTS_SUBMITTED' }),
      });
    });
  });
});

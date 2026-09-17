import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminClientReviewService } from './admin-client-review.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AdminClientReviewService', () => {
  let service: AdminClientReviewService;
  let prisma: {
    client: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { update: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      client: { findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { update: jest.fn() },
    };
    service = new AdminClientReviewService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('lists all clients with their onboarding record when no status filter is given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      await service.list();
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: undefined, include: { onboarding: true } }),
      );
    });

    it('filters by status when given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      await service.list('MANUAL_REVIEW' as never);
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'MANUAL_REVIEW' } }),
      );
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
  });
});

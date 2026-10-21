import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminClientReviewService } from './admin-client-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClientOnboardingService } from '../client-onboarding/client-onboarding.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';

describe('AdminClientReviewService', () => {
  let service: AdminClientReviewService;
  let prisma: {
    client: { findMany: jest.Mock; count: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
    clientOnboarding: { update: jest.Mock };
  };
  let clientOnboardingService: { determineStepAfterIdentity: jest.Mock };
  let fileStorageProvider: { getSignedDownloadUrl: jest.Mock };
  let clientLoanSummaryService: { getSummary: jest.Mock; getSchedule: jest.Mock; getTopupEligibility: jest.Mock };

  beforeEach(() => {
    prisma = {
      client: { findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      clientOnboarding: { update: jest.fn() },
    };
    clientOnboardingService = { determineStepAfterIdentity: jest.fn() };
    fileStorageProvider = { getSignedDownloadUrl: jest.fn() };
    clientLoanSummaryService = {
      getSummary: jest.fn().mockResolvedValue({
        hasLoan: false,
        source: null,
        status: null,
        principal: null,
        balance: null,
        monthlyRepayment: null,
        nextPaymentDate: null,
      }),
      getSchedule: jest.fn().mockResolvedValue(null),
      getTopupEligibility: jest.fn().mockResolvedValue({ eligible: false, reason: 'Client has not completed onboarding' }),
    };
    service = new AdminClientReviewService(
      prisma as unknown as PrismaService,
      clientOnboardingService as unknown as ClientOnboardingService,
      fileStorageProvider as unknown as FileStorageProvider,
      clientLoanSummaryService as unknown as ClientLoanSummaryService,
    );
  });

  describe('list', () => {
    it('lists all clients with their onboarding record, defaulting to page 1/limit 25', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      const result = await service.list();

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: undefined, phone: undefined, createdAt: undefined, onboarding: undefined },
          include: {
            createdByAdmin: { select: { id: true, fullName: true, email: true } },
            onboarding: {
              include: {
                ippisRecord: true,
                reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
                onboardedByAdmin: { select: { id: true, fullName: true, email: true } },
                onboardedByAgent: { select: { id: true, fullName: true, email: true } },
              },
            },
          },
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

    it('attaches a derived onboardingSource to each row', async () => {
      prisma.client.findMany.mockResolvedValue([
        { id: 'c1', onboarding: { onboardedById: null, onboardedByAgentId: null } },
        { id: 'c2', onboarding: { onboardedById: null, onboardedByAgentId: 'agent-1' } },
        { id: 'c3', onboarding: { onboardedById: 'admin-1', onboardedByAgentId: null } },
        { id: 'c4', onboarding: null },
      ]);
      prisma.client.count.mockResolvedValue(4);

      const result = await service.list();

      expect(result.data.map((c: { onboardingSource: string | null }) => c.onboardingSource)).toEqual([
        'SELF',
        'AGENT',
        'ADMIN',
        null,
      ]);
    });

    it('resolves the onboarding relations (ippisRecord, onboardedByAgent) and createdByAdmin, narrowing ippisRecord the same way findById does', async () => {
      prisma.client.findMany.mockResolvedValue([
        {
          id: 'c1',
          createdByAdmin: { id: 'admin-1', fullName: 'Admin One', email: 'admin1@example.com' },
          onboarding: {
            onboardedById: null,
            onboardedByAgentId: 'agent-1',
            onboardedByAgent: { id: 'agent-1', fullName: 'Agent One', email: 'agent1@example.com' },
            bvnSelfie: 'client-onboarding/c1/bvn-selfie.jpg',
            ninSelfie: null,
            liveSelfieKey: null,
            ippisRecord: {
              agency: 'NPF',
              staffId: 'S1',
              employeeName: 'Jane Doe',
              employeeStatus: 'ACTIVE',
              hireDate: null,
              department: 'IT',
              grade: 'GL07',
              bankName: 'GTBank',
              accountNumber: '0123456789',
              bvn: '12345678901',
              salary: 500000,
            },
          },
        },
      ]);
      prisma.client.count.mockResolvedValue(1);
      fileStorageProvider.getSignedDownloadUrl.mockImplementation((key: string) =>
        Promise.resolve(`https://storage.example.com/${key}`),
      );

      const result = await service.list();

      expect(result.data[0].createdByAdmin).toEqual({ id: 'admin-1', fullName: 'Admin One', email: 'admin1@example.com' });
      expect(result.data[0].onboarding.bvnSelfieUrl).toBe(
        'https://storage.example.com/client-onboarding/c1/bvn-selfie.jpg',
      );
      expect(result.data[0].onboarding.ninSelfieUrl).toBeNull();
      expect(result.data[0].onboarding).not.toHaveProperty('bvnSelfie');
      expect(result.data[0].onboarding).not.toHaveProperty('ninSelfie');
      expect(result.data[0].onboarding).not.toHaveProperty('liveSelfieKey');
      expect(result.data[0].onboarding.onboardedByAgent).toEqual({
        id: 'agent-1',
        fullName: 'Agent One',
        email: 'agent1@example.com',
      });
      expect(result.data[0].onboarding.ippisRecord).toEqual({
        agency: 'NPF',
        staffId: 'S1',
        employeeName: 'Jane Doe',
        employeeStatus: 'ACTIVE',
        hireDate: null,
        department: 'IT',
        grade: 'GL07',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });
      expect(result.data[0].onboarding.ippisRecord).not.toHaveProperty('bvn');
      expect(result.data[0].onboarding.ippisRecord).not.toHaveProperty('salary');
    });

    it('translates the onboardingSource filter into the matching where clause', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ onboardingSource: 'AGENT' });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ onboarding: { onboardedByAgentId: { not: null } } }) }),
      );

      await service.list({ onboardingSource: 'ADMIN' });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ onboarding: { onboardedById: { not: null } } }) }),
      );

      await service.list({ onboardingSource: 'SELF' });
      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedById: null, onboardedByAgentId: null } }),
        }),
      );
    });

    it('filters by agentId', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ agentId: 'agent-1' });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedByAgentId: 'agent-1' } }),
        }),
      );
    });

    it('overrides onboardingSource with the exact agentId when both are given', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(0);

      await service.list({ onboardingSource: 'AGENT' as never, agentId: 'agent-1' });

      expect(prisma.client.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ onboarding: { onboardedByAgentId: 'agent-1' } }),
        }),
      );
    });

    it('computes skip/take from page and limit and reports the total', async () => {
      prisma.client.findMany.mockResolvedValue([]);
      prisma.client.count.mockResolvedValue(60);

      const result = await service.list({}, { page: 3, limit: 25 });

      expect(prisma.client.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 50, take: 25 }));
      expect(result.meta).toEqual({ total: 60, page: 3, limit: 25, totalPages: 3 });
    });

    it('attaches loanSummary and topupEligibility to each row', async () => {
      prisma.client.findMany.mockResolvedValue([{ id: 'c1', onboarding: null }]);
      prisma.client.count.mockResolvedValue(1);
      clientLoanSummaryService.getSummary.mockResolvedValue({
        hasLoan: true,
        source: 'INGESTED',
        status: 'DEFAULT',
        principal: 50000,
        balance: 20000,
        monthlyRepayment: 10000,
        nextPaymentDate: null,
      });
      clientLoanSummaryService.getTopupEligibility.mockResolvedValue({ eligible: true });

      const result = await service.list();

      expect(clientLoanSummaryService.getSummary).toHaveBeenCalledWith('c1');
      expect(result.data[0].loanSummary.status).toBe('DEFAULT');
      expect(result.data[0].topupEligibility).toEqual({ eligible: true });
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

    it('includes a derived onboardingSource', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        onboarding: { id: 'o1', onboardedById: null, onboardedByAgentId: 'agent-1' },
      });
      const result = await service.findById('c1');
      expect(result.onboardingSource).toBe('AGENT');
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
        include: {
          createdByAdmin: { select: { id: true, fullName: true, email: true } },
          onboarding: {
            include: {
              documents: true,
              ippisRecord: true,
              reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
              onboardedByAdmin: { select: { id: true, fullName: true, email: true } },
              onboardedByAgent: { select: { id: true, fullName: true, email: true } },
            },
          },
        },
      });
      expect(result.onboarding.lengthOfService).toEqual({ years: 1, months: 0 });
    });

    it('surfaces the reviewedByAdmin relation when the onboarding has been reviewed', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        onboarding: { id: 'o1', reviewedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' } },
      });

      const result = await service.findById('c1');

      expect(result.onboarding.reviewedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });

    it('surfaces createdByAdmin and onboardedByAdmin when the client/onboarding were admin-initiated', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'VERIFIED',
        createdByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' },
        onboarding: { id: 'o1', onboardedByAdmin: { id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' } },
      });

      const result = await service.findById('c1');

      expect(result.createdByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
      expect(result.onboarding.onboardedByAdmin).toEqual({ id: 'admin-1', fullName: 'Jane Doe', email: 'jane@x.com' });
    });

    it('trims the nested ippisRecord and resolves identity selfie keys to signed URLs', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'MANUAL_REVIEW',
        onboarding: {
          id: 'o1',
          bvnSelfie: 'client-onboarding/c1/bvn-selfie.jpg',
          ninSelfie: 'client-onboarding/c1/nin-selfie.jpg',
          liveSelfieKey: 'client-onboarding/c1/live-selfie.jpg',
          ippisRecord: {
            agency: 'NPF',
            staffId: 'NPF-001',
            employeeName: 'Jane Doe',
            employeeStatus: 'ACTIVE',
            hireDate: new Date('2020-01-01'),
            department: 'Finance',
            grade: 'GL-08',
            bankName: 'GTBank',
            accountNumber: '0123456789',
            salary: 500000,
            pinNumber: 'secret-pin',
            pfaName: 'Some PFA',
            bvn: '99999999999',
            rawFields: { anything: 'here' },
          },
        },
      });
      fileStorageProvider.getSignedDownloadUrl.mockImplementation(
        async (key: string) => `https://signed-url.example/${key}`,
      );

      const result = await service.findById('c1');

      expect(result.onboarding.ippisRecord).toEqual({
        agency: 'NPF',
        staffId: 'NPF-001',
        employeeName: 'Jane Doe',
        employeeStatus: 'ACTIVE',
        hireDate: new Date('2020-01-01'),
        department: 'Finance',
        grade: 'GL-08',
        bankName: 'GTBank',
        accountNumber: '0123456789',
      });
      expect(result.onboarding.bvnSelfieUrl).toBe('https://signed-url.example/client-onboarding/c1/bvn-selfie.jpg');
      expect(result.onboarding.ninSelfieUrl).toBe('https://signed-url.example/client-onboarding/c1/nin-selfie.jpg');
      expect(result.onboarding.liveSelfieUrl).toBe('https://signed-url.example/client-onboarding/c1/live-selfie.jpg');
      expect(result.onboarding).not.toHaveProperty('bvnSelfie');
      expect(result.onboarding).not.toHaveProperty('ninSelfie');
      expect(result.onboarding).not.toHaveProperty('liveSelfieKey');
    });

    it('does not attempt to resolve selfie URLs that are not set', async () => {
      prisma.client.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'PENDING_IPPIS',
        onboarding: { id: 'o1' },
      });

      const result = await service.findById('c1');

      expect(result.onboarding.bvnSelfieUrl).toBeNull();
      expect(result.onboarding.ninSelfieUrl).toBeNull();
      expect(result.onboarding.liveSelfieUrl).toBeNull();
      expect(fileStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('attaches loanSummary, topupEligibility, and loanSchedule', async () => {
      prisma.client.findUnique.mockResolvedValue({ id: 'c1', status: 'VERIFIED', onboarding: null });
      clientLoanSummaryService.getSchedule.mockResolvedValue([{ period: '2026-01' }]);
      clientLoanSummaryService.getTopupEligibility.mockResolvedValue({
        eligible: false,
        reason: 'Client has no existing loan to renew',
      });

      const result = await service.findById('c1');

      expect(clientLoanSummaryService.getSummary).toHaveBeenCalledWith('c1');
      expect(result.topupEligibility).toEqual({ eligible: false, reason: 'Client has no existing loan to renew' });
      expect(result.loanSchedule).toEqual([{ period: '2026-01' }]);
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

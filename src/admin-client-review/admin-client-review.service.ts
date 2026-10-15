import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, OnboardingStep, Prisma } from '../generated/prisma/client';
import { ClientOnboardingService } from '../client-onboarding/client-onboarding.service';
import { computeLengthOfService } from '../client-onboarding/length-of-service.util';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { deriveOnboardingSource, OnboardingSource } from '../client-onboarding/onboarding-source.util';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';

interface FailureReasons {
  identityVerified?: boolean;
  faceMatchPassed?: boolean;
}

export interface ListClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  onboardingSource?: OnboardingSource;
}

@Injectable()
export class AdminClientReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientOnboardingService: ClientOnboardingService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async list(
    filters: ListClientsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientWhereInput = {
      status: filters.status,
      phone: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      onboarding: this.buildOnboardingSourceWhere(filters.onboardingSource),
    };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
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
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.client.count({ where }),
    ]);

    return buildPaginatedResult(
      data.map((client) => ({
        ...client,
        onboardingSource: deriveOnboardingSource(client.onboarding),
        onboarding: client.onboarding
          ? { ...client.onboarding, ippisRecord: narrowIppisRecord(client.onboarding.ippisRecord) }
          : null,
      })),
      total,
      page,
      limit,
    );
  }

  private buildOnboardingSourceWhere(onboardingSource?: OnboardingSource) {
    if (!onboardingSource) return undefined;
    if (onboardingSource === 'AGENT') return { onboardedByAgentId: { not: null } };
    if (onboardingSource === 'ADMIN') return { onboardedById: { not: null } };
    return { onboardedById: null, onboardedByAgentId: null }; // SELF
  }

  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
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
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    if (client.onboarding) {
      const documents = await Promise.all(
        (client.onboarding.documents ?? []).map(async (document) => ({
          documentType: document.documentType,
          url: await this.fileStorageProvider.getSignedDownloadUrl(document.storageKey),
          uploadedAt: document.uploadedAt,
        })),
      );
      const lengthOfService = computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null);
      const ippisRecord = narrowIppisRecord(client.onboarding.ippisRecord);

      const bvnSelfieUrl = client.onboarding.bvnSelfie
        ? await this.fileStorageProvider.getSignedDownloadUrl(client.onboarding.bvnSelfie)
        : null;
      const ninSelfieUrl = client.onboarding.ninSelfie
        ? await this.fileStorageProvider.getSignedDownloadUrl(client.onboarding.ninSelfie)
        : null;
      const liveSelfieUrl = client.onboarding.liveSelfieKey
        ? await this.fileStorageProvider.getSignedDownloadUrl(client.onboarding.liveSelfieKey)
        : null;

      return {
        ...client,
        onboardingSource: deriveOnboardingSource(client.onboarding),
        onboarding: {
          ...client.onboarding,
          documents,
          lengthOfService,
          ippisRecord,
          bvnSelfieUrl,
          ninSelfieUrl,
          liveSelfieUrl,
        },
      };
    }

    return { ...client, onboardingSource: deriveOnboardingSource(client.onboarding), onboarding: null };
  }

  async approve(id: string, adminId: string) {
    const client = await this.findById(id);
    if (client.status !== ClientStatus.MANUAL_REVIEW) {
      throw new ConflictException(`Client is not in MANUAL_REVIEW (currently ${client.status})`);
    }

    await this.prisma.clientOnboarding.update({
      where: { clientId: id },
      data: {
        step: OnboardingStep.COMPLETED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });

    return this.prisma.client.update({
      where: { id },
      data: { status: ClientStatus.VERIFIED },
    });
  }

  async retry(id: string, adminId: string, note: string) {
    const client = await this.findById(id);
    if (client.status !== ClientStatus.MANUAL_REVIEW) {
      throw new ConflictException(`Client is not in MANUAL_REVIEW (currently ${client.status})`);
    }
    if (!client.onboarding) {
      throw new ConflictException('Client has no onboarding record to retry');
    }

    const failureReasons = client.onboarding.failureReasons as FailureReasons | null;
    const identityFailed = failureReasons?.identityVerified === false;

    const resetData = identityFailed
      ? {
          step: OnboardingStep.IPPIS_LINKED,
          bvn: null,
          nin: null,
          bvnSelfie: null,
          ninSelfie: null,
          identityVerified: null,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        }
      : {
          step: await this.clientOnboardingService.determineStepAfterIdentity(client.onboarding.id),
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        };

    await this.prisma.clientOnboarding.update({
      where: { clientId: id },
      data: {
        ...resetData,
        failureReasons: null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });

    return this.prisma.client.update({
      where: { id },
      data: { status: ClientStatus.PENDING_IPPIS },
    });
  }
}

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, OnboardingStep, Prisma } from '../generated/prisma/client';
import { ClientOnboardingService } from '../client-onboarding/client-onboarding.service';
import { computeLengthOfService } from '../client-onboarding/length-of-service.util';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

interface FailureReasons {
  identityVerified?: boolean;
  faceMatchPassed?: boolean;
}

export interface ListClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
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
    };

    const [data, total] = await Promise.all([
      this.prisma.client.findMany({
        where,
        include: { onboarding: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.client.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: { include: { documents: true, ippisRecord: true } } },
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

      const ippisRecord = client.onboarding.ippisRecord
        ? {
            agency: client.onboarding.ippisRecord.agency,
            staffId: client.onboarding.ippisRecord.staffId,
            employeeName: client.onboarding.ippisRecord.employeeName,
            employeeStatus: client.onboarding.ippisRecord.employeeStatus,
            hireDate: client.onboarding.ippisRecord.hireDate,
            department: client.onboarding.ippisRecord.department,
            grade: client.onboarding.ippisRecord.grade,
            bankName: client.onboarding.ippisRecord.bankName,
            accountNumber: client.onboarding.ippisRecord.accountNumber,
          }
        : undefined;

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

    return { ...client, onboarding: null };
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

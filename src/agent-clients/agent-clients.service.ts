import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';

export interface ListMyClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AgentClientsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async listMyClients(
    agentId: string,
    filters: ListMyClientsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.ClientWhereInput = {
      onboarding: { onboardedByAgentId: agentId },
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
        include: {
          onboarding: {
            include: {
              ippisRecord: true,
              reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
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
      await Promise.all(data.map((client) => this.narrowClient(client))),
      total,
      page,
      limit,
    );
  }

  private async narrowClient<
    T extends {
      onboarding:
        | ({
            bvnSelfie: string | null;
            ninSelfie: string | null;
            liveSelfieKey: string | null;
            ippisRecord: Parameters<typeof narrowIppisRecord>[0];
          } & Record<string, unknown>)
        | null;
    },
  >(client: T) {
    if (!client.onboarding) {
      return { ...client, onboarding: null };
    }

    const { bvnSelfie, ninSelfie, liveSelfieKey, ippisRecord, ...restOnboarding } = client.onboarding;
    const [bvnSelfieUrl, ninSelfieUrl, liveSelfieUrl] = await Promise.all([
      bvnSelfie ? this.fileStorageProvider.getSignedDownloadUrl(bvnSelfie) : null,
      ninSelfie ? this.fileStorageProvider.getSignedDownloadUrl(ninSelfie) : null,
      liveSelfieKey ? this.fileStorageProvider.getSignedDownloadUrl(liveSelfieKey) : null,
    ]);

    return {
      ...client,
      onboarding: {
        ...restOnboarding,
        ippisRecord: narrowIppisRecord(ippisRecord),
        bvnSelfieUrl,
        ninSelfieUrl,
        liveSelfieUrl,
      },
    };
  }
}

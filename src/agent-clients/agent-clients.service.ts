import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Client, ClientStatus, IppisRecord, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientLoanSummaryService } from '../client-loan-summary/client-loan-summary.service';

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
    private readonly clientLoanSummaryService: ClientLoanSummaryService,
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
      id: string;
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
    const [loanSummary, topupEligibility] = await Promise.all([
      this.clientLoanSummaryService.getSummary(client.id),
      this.clientLoanSummaryService.getTopupEligibility(
        client as unknown as Client,
        client.onboarding as unknown as { ippisRecord: IppisRecord } | null,
      ),
    ]);

    if (!client.onboarding) {
      return { ...client, onboarding: null, loanSummary, topupEligibility };
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
      loanSummary,
      topupEligibility,
    };
  }

  async getOneForAgent(agentId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, onboarding: { onboardedByAgentId: agentId } },
      include: {
        onboarding: {
          include: {
            ippisRecord: true,
            reviewedByAdmin: { select: { id: true, fullName: true, email: true } },
            documents: true,
          },
        },
      },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const narrowed = await this.narrowClient(client);
    const loanSchedule = await this.clientLoanSummaryService.getSchedule(clientId);

    return { ...narrowed, loanSchedule };
  }
}

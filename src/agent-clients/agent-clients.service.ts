import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';

export interface ListMyClientsFilters {
  status?: ClientStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AgentClientsService {
  constructor(private readonly prisma: PrismaService) {}

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
      data.map((client) => ({
        ...client,
        onboarding: client.onboarding
          ? { ...client.onboarding, ippisRecord: narrowIppisRecord(client.onboarding.ippisRecord) }
          : null,
      })),
      total,
      page,
      limit,
    );
  }
}

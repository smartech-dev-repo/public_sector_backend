import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentApplication, AgentApplicationStatus, AgentStatus, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';

export interface ListRecruitmentApplicationsFilters {
  status?: AgentApplicationStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface RecruitmentApplicationAnalyticsFilters {
  createdFrom?: Date;
  createdTo?: Date;
}

export interface RecruitmentApplicationAnalyticsSummary {
  totalApplications: number;
  byStatus: Record<AgentApplicationStatus, number>;
  conversionRate: number | null;
  averageTimeToSubmitHours: number | null;
}

type ApplicationWithSubmittedAgent = AgentApplication & {
  submittedAgent: { id: string; status: AgentStatus } | null;
};

@Injectable()
export class AdminAgentRecruitmentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async list(
    filters: ListRecruitmentApplicationsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.AgentApplicationWhereInput = {
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { email: { contains: filters.q, mode: 'insensitive' } },
            { fullName: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
      // Once the resulting agent is APPROVED, the application has graduated
      // out of the recruitment pipeline -- it only shows up in the agent
      // list (admin/agents) from then on. `isNot` also matches applications
      // with no submittedAgent at all.
      submittedAgent: { isNot: { status: AgentStatus.APPROVED } },
    };

    const [data, total] = await Promise.all([
      this.prisma.agentApplication.findMany({
        where,
        include: { submittedAgent: { select: { id: true, status: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.agentApplication.count({ where }),
    ]);

    return buildPaginatedResult(
      await Promise.all(data.map((row) => this.narrow(row as ApplicationWithSubmittedAgent))),
      total,
      page,
      limit,
    );
  }

  async findById(id: string) {
    const application = await this.prisma.agentApplication.findUnique({
      where: { id },
      include: { submittedAgent: { select: { id: true, status: true } } },
    });
    if (!application) {
      throw new NotFoundException('Recruitment application not found');
    }
    return this.narrow(application as ApplicationWithSubmittedAgent);
  }

  async getAnalytics(
    filters: RecruitmentApplicationAnalyticsFilters = {},
  ): Promise<RecruitmentApplicationAnalyticsSummary> {
    const where: Prisma.AgentApplicationWhereInput = {
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [totalApplications, statusGroups, submittedRows] = await Promise.all([
      this.prisma.agentApplication.count({ where }),
      this.prisma.agentApplication.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.agentApplication.findMany({
        where: { ...where, status: AgentApplicationStatus.SUBMITTED },
        include: { submittedAgent: { select: { createdAt: true } } },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(AgentApplicationStatus).map((status) => [
        status,
        statusGroups.find((g) => g.status === status)?._count._all ?? 0,
      ]),
    ) as Record<AgentApplicationStatus, number>;

    const submittedCount = byStatus[AgentApplicationStatus.SUBMITTED];
    const conversionRate = totalApplications === 0 ? null : submittedCount / totalApplications;

    const submitDurationsMs = submittedRows
      .filter((row) => row.submittedAgent)
      .map((row) => row.submittedAgent!.createdAt.getTime() - row.createdAt.getTime());
    const averageTimeToSubmitHours =
      submitDurationsMs.length === 0
        ? null
        : submitDurationsMs.reduce((sum, ms) => sum + ms, 0) / submitDurationsMs.length / (1000 * 60 * 60);

    return { totalApplications, byStatus, conversionRate, averageTimeToSubmitHours };
  }

  async remove(id: string): Promise<void> {
    const application = await this.prisma.agentApplication.findUnique({ where: { id } });
    if (!application) {
      throw new NotFoundException('Recruitment application not found');
    }
    if (application.status === AgentApplicationStatus.SUBMITTED) {
      throw new ConflictException('Cannot delete an application that has already been submitted');
    }
    await this.prisma.agentApplication.delete({ where: { id } });
  }

  private async narrow(row: ApplicationWithSubmittedAgent) {
    const [cvUrl, passportPhotoUrl, identityDocumentUrl] = await Promise.all([
      row.cvKey ? this.fileStorageProvider.getSignedDownloadUrl(row.cvKey) : null,
      row.passportPhotoKey ? this.fileStorageProvider.getSignedDownloadUrl(row.passportPhotoKey) : null,
      row.identityDocumentKey ? this.fileStorageProvider.getSignedDownloadUrl(row.identityDocumentKey) : null,
    ]);

    return {
      id: row.id,
      email: row.email,
      status: row.status,
      emailVerifiedAt: row.emailVerifiedAt,
      fullName: row.fullName,
      phone: row.phone,
      gender: row.gender,
      address: row.address,
      city: row.city,
      state: row.state,
      localGovernment: row.localGovernment,
      nin: row.nin,
      ninVerified: row.ninVerified,
      ninVerifiedName: row.ninVerifiedName,
      coverLetter: row.coverLetter,
      cvUrl,
      passportPhotoUrl,
      identityDocumentUrl,
      submittedAgent: row.submittedAgent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentStatus, Prisma } from '../generated/prisma/client';

export interface AgentAnalyticsFilters {
  createdFrom?: Date;
  createdTo?: Date;
}

export interface AgentAnalyticsSummary {
  totalApplications: number;
  byStatus: Record<AgentStatus, number>;
  reviewerLeaderboard: Array<{ adminId: string; adminName: string; approvedCount: number; rejectedCount: number }>;
  activity: { averageReviewTimeHours: number | null; totalApproved: number; totalRejected: number };
}

@Injectable()
export class AdminAgentAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(filters: AgentAnalyticsFilters = {}): Promise<AgentAnalyticsSummary> {
    const agentWhere: Prisma.AgentWhereInput = {
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [totalApplications, statusGroups, reviewerLeaderboard, activity] = await Promise.all([
      this.prisma.agent.count({ where: agentWhere }),
      this.prisma.agent.groupBy({ by: ['status'], where: agentWhere, _count: { _all: true } }),
      this.buildReviewerLeaderboard(agentWhere),
      this.buildActivity(agentWhere),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(AgentStatus).map((status) => [
        status,
        statusGroups.find((g) => g.status === status)?._count._all ?? 0,
      ]),
    ) as Record<AgentStatus, number>;

    return { totalApplications, byStatus, reviewerLeaderboard, activity };
  }

  private async buildReviewerLeaderboard(agentWhere: Prisma.AgentWhereInput) {
    const grouped = await this.prisma.agent.groupBy({
      by: ['reviewedBy'],
      where: { ...agentWhere, reviewedBy: { not: null } },
      _count: { _all: true },
    });

    const results = await Promise.all(
      grouped.map(async (group) => {
        const adminId = group.reviewedBy!;
        const [admin, approvedCount, rejectedCount] = await Promise.all([
          this.prisma.adminUser.findUnique({ where: { id: adminId }, select: { fullName: true } }),
          this.prisma.agent.count({ where: { ...agentWhere, reviewedBy: adminId, status: AgentStatus.APPROVED } }),
          this.prisma.agent.count({ where: { ...agentWhere, reviewedBy: adminId, status: AgentStatus.REJECTED } }),
        ]);
        return {
          adminId,
          adminName: admin?.fullName ?? 'Unknown admin',
          approvedCount,
          rejectedCount,
        };
      }),
    );

    return results.sort((a, b) => b.approvedCount + b.rejectedCount - (a.approvedCount + a.rejectedCount));
  }

  private async buildActivity(agentWhere: Prisma.AgentWhereInput) {
    const [totalApproved, totalRejected, reviewedAgents] = await Promise.all([
      this.prisma.agent.count({ where: { ...agentWhere, status: AgentStatus.APPROVED } }),
      this.prisma.agent.count({ where: { ...agentWhere, status: AgentStatus.REJECTED } }),
      this.prisma.agent.findMany({
        where: { ...agentWhere, reviewedAt: { not: null } },
        select: { createdAt: true, reviewedAt: true },
      }),
    ]);

    const averageReviewTimeHours =
      reviewedAgents.length === 0
        ? null
        : reviewedAgents.reduce((sum, a) => sum + (a.reviewedAt!.getTime() - a.createdAt.getTime()), 0) /
          reviewedAgents.length /
          (1000 * 60 * 60);

    return { averageReviewTimeHours, totalApproved, totalRejected };
  }
}

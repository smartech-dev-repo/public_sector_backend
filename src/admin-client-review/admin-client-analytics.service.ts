import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, OnboardingStep, Prisma } from '../generated/prisma/client';

export interface ClientAnalyticsFilters {
  createdFrom?: Date;
  createdTo?: Date;
}

export interface ClientAnalyticsSummary {
  totalClients: number;
  bySource: { SELF: number; AGENT: number; ADMIN: number; NONE: number };
  byOnboardingStep: Record<OnboardingStep, number>;
  byClientStatus: Record<ClientStatus, number>;
  agentLeaderboard: Array<{
    agentId: string;
    agentName: string;
    totalOnboarded: number;
    completedCount: number;
    stalledCount: number;
  }>;
  activity: {
    clientsWithAtLeastOneLoanRequest: number;
    clientsWithAtLeastOneDisbursedLoan: number;
    clientsWithAtLeastOneSession: number;
    totalLoanRequests: number;
    totalWalletEntries: number;
  };
}

@Injectable()
export class AdminClientAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(filters: ClientAnalyticsFilters = {}): Promise<ClientAnalyticsSummary> {
    const clientWhere: Prisma.ClientWhereInput = {
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [
      totalClients,
      selfCount,
      agentCount,
      adminCount,
      noneCount,
      onboardingStepGroups,
      clientStatusGroups,
      agentLeaderboard,
      activity,
    ] = await Promise.all([
      this.prisma.client.count({ where: clientWhere }),
      this.prisma.client.count({
        where: { ...clientWhere, onboarding: { onboardedById: null, onboardedByAgentId: null } },
      }),
      this.prisma.client.count({ where: { ...clientWhere, onboarding: { onboardedByAgentId: { not: null } } } }),
      this.prisma.client.count({ where: { ...clientWhere, onboarding: { onboardedById: { not: null } } } }),
      this.prisma.client.count({ where: { ...clientWhere, onboarding: null } }),
      this.prisma.clientOnboarding.groupBy({
        by: ['step'],
        where: { client: clientWhere },
        _count: { _all: true },
      }),
      this.prisma.client.groupBy({
        by: ['status'],
        where: clientWhere,
        _count: { _all: true },
      }),
      this.buildAgentLeaderboard(clientWhere),
      this.buildActivity(clientWhere),
    ]);

    const byOnboardingStep = Object.fromEntries(
      Object.values(OnboardingStep).map((step) => [
        step,
        onboardingStepGroups.find((g) => g.step === step)?._count._all ?? 0,
      ]),
    ) as Record<OnboardingStep, number>;

    const byClientStatus = Object.fromEntries(
      Object.values(ClientStatus).map((status) => [
        status,
        clientStatusGroups.find((g) => g.status === status)?._count._all ?? 0,
      ]),
    ) as Record<ClientStatus, number>;

    return {
      totalClients,
      bySource: { SELF: selfCount, AGENT: agentCount, ADMIN: adminCount, NONE: noneCount },
      byOnboardingStep,
      byClientStatus,
      agentLeaderboard,
      activity,
    };
  }

  private async buildAgentLeaderboard(clientWhere: Prisma.ClientWhereInput) {
    const grouped = await this.prisma.clientOnboarding.groupBy({
      by: ['onboardedByAgentId'],
      where: { onboardedByAgentId: { not: null }, client: clientWhere },
      _count: { _all: true },
    });

    const results = await Promise.all(
      grouped.map(async (group) => {
        const agentId = group.onboardedByAgentId!;
        const [agent, completedCount] = await Promise.all([
          this.prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } }),
          this.prisma.clientOnboarding.count({
            where: { onboardedByAgentId: agentId, step: OnboardingStep.COMPLETED, client: clientWhere },
          }),
        ]);
        const totalOnboarded = group._count._all;
        return {
          agentId,
          agentName: agent?.fullName ?? 'Unknown agent',
          totalOnboarded,
          completedCount,
          stalledCount: totalOnboarded - completedCount,
        };
      }),
    );

    return results.sort((a, b) => b.totalOnboarded - a.totalOnboarded);
  }

  private async buildActivity(clientWhere: Prisma.ClientWhereInput) {
    const [
      clientsWithAtLeastOneLoanRequest,
      clientsWithAtLeastOneDisbursedLoan,
      clientsWithAtLeastOneSession,
      totalLoanRequests,
      totalWalletEntries,
    ] = await Promise.all([
      this.prisma.client.count({ where: { ...clientWhere, loanRequests: { some: {} } } }),
      this.prisma.client.count({ where: { ...clientWhere, clientLoans: { some: {} } } }),
      this.countClientsWithSession(clientWhere),
      this.prisma.loanRequest.count({ where: { client: clientWhere } }),
      this.prisma.walletEntry.count({ where: { client: clientWhere } }),
    ]);

    return {
      clientsWithAtLeastOneLoanRequest,
      clientsWithAtLeastOneDisbursedLoan,
      clientsWithAtLeastOneSession,
      totalLoanRequests,
      totalWalletEntries,
    };
  }

  private async countClientsWithSession(clientWhere: Prisma.ClientWhereInput): Promise<number> {
    const clients = await this.prisma.client.findMany({ where: clientWhere, select: { id: true } });
    if (clients.length === 0) return 0;
    const sessions = await this.prisma.session.findMany({
      where: { principalType: 'CLIENT', principalId: { in: clients.map((c) => c.id) } },
      select: { principalId: true },
      distinct: ['principalId'],
    });
    return sessions.length;
  }
}

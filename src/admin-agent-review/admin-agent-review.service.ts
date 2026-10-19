import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { generateOpaqueToken } from '../common/opaque-token.util';
import { hashPassword } from '../common/password-hash.util';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { Agent, AgentStatus, Prisma } from '../generated/prisma/client';
import { agentApplicationRejectedEmail, agentCredentialsEmail } from '../email/templates/action-emails';

export interface ListAgentsFilters {
  status?: AgentStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  reviewedFrom?: Date;
  reviewedTo?: Date;
}

@Injectable()
export class AdminAgentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async list(
    filters: ListAgentsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.AgentWhereInput = {
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      reviewedAt:
        filters.reviewedFrom || filters.reviewedTo
          ? { gte: filters.reviewedFrom, lte: filters.reviewedTo }
          : undefined,
      OR: filters.q
        ? [
            { fullName: { contains: filters.q, mode: 'insensitive' } },
            { email: { contains: filters.q, mode: 'insensitive' } },
            { phone: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.agent.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async findById(id: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    return agent;
  }

  async setOnboardingAccess(id: string, canOnboardClients: boolean): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (canOnboardClients && agent.status !== AgentStatus.APPROVED) {
      throw new UnprocessableEntityException('Agent must be APPROVED before granting client-onboarding access');
    }

    return this.prisma.agent.update({ where: { id }, data: { canOnboardClients } });
  }

  async approve(id: string, reviewerId: string): Promise<void> {
    const agent = await this.loadPendingReview(id);
    await this.issueCredentials(agent, { reviewerId });
  }

  async reject(id: string, reviewerId: string, reason: string): Promise<void> {
    const agent = await this.loadPendingReview(id);

    await this.prisma.agent.update({
      where: { id },
      data: {
        status: AgentStatus.REJECTED,
        rejectionReason: reason,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });

    await this.emailService.send({ to: agent.email, ...agentApplicationRejectedEmail({ fullName: agent.fullName, reason }) });
  }

  async resendCredentials(id: string, reviewerId: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (agent.status !== AgentStatus.APPROVED) {
      throw new ConflictException(`Agent is not APPROVED (currently ${agent.status})`);
    }
    if (agent.hasLoggedIn) {
      throw new ConflictException('Credentials have already been used and can no longer be resent');
    }

    await this.issueCredentials(agent, {});
  }

  private async loadPendingReview(id: string): Promise<Agent> {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    if (agent.status !== AgentStatus.PENDING_REVIEW) {
      throw new ConflictException(`Agent is not PENDING_REVIEW (currently ${agent.status})`);
    }
    return agent;
  }

  private async issueCredentials(agent: Agent, options: { reviewerId?: string }): Promise<void> {
    const temporaryPassword = generateOpaqueToken();
    const passwordHash = await hashPassword(temporaryPassword);

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordHash,
        mustChangePassword: true,
        status: AgentStatus.APPROVED,
        ...(options.reviewerId ? { reviewedBy: options.reviewerId, reviewedAt: new Date() } : {}),
      },
    });

    const downloadUrl = this.configService.get<string>('AGENT_APP_DOWNLOAD_URL');

    await this.emailService.send({
      to: agent.email,
      ...agentCredentialsEmail({ fullName: agent.fullName, email: agent.email, temporaryPassword, downloadUrl }),
    });
  }
}

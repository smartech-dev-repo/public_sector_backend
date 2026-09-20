import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { generateOpaqueToken } from '../common/opaque-token.util';
import { hashPassword } from '../common/password-hash.util';
import { Agent, AgentStatus } from '../generated/prisma/client';

@Injectable()
export class AdminAgentReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async list(status?: AgentStatus) {
    return this.prisma.agent.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id } });
    if (!agent) {
      throw new NotFoundException('Agent not found');
    }
    return agent;
  }

  async approve(id: string, reviewerId: string): Promise<void> {
    const agent = await this.loadPendingReview(id);
    await this.issueCredentials(agent, { reviewerId });
  }

  async reject(id: string, reviewerId: string, reason: string): Promise<void> {
    await this.loadPendingReview(id);

    await this.prisma.agent.update({
      where: { id },
      data: {
        status: AgentStatus.REJECTED,
        rejectionReason: reason,
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
      },
    });
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
    const downloadHtml = downloadUrl ? `<p>Download the app: ${downloadUrl}</p>` : '';
    const downloadText = downloadUrl ? `Download the app: ${downloadUrl}\n` : '';

    await this.emailService.send({
      to: agent.email,
      subject: 'Your agent account has been approved',
      html: `<p>Email: ${agent.email}</p><p>Temporary password: ${temporaryPassword}</p>${downloadHtml}<p>You will be required to change this password on first login.</p>`,
      text: `Email: ${agent.email}\nTemporary password: ${temporaryPassword}\n${downloadText}You will be required to change this password on first login.`,
    });
  }
}

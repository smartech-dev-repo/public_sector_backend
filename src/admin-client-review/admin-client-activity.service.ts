import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditActorType, SessionPrincipalType } from '../generated/prisma/client';

export interface ActivityEntry {
  timestamp: Date;
  type: string;
  description: string;
  source: 'AUDIT_LOG' | 'LOAN_REQUEST' | 'SESSION' | 'WALLET' | 'ONBOARDING';
}

@Injectable()
export class AdminClientActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async listActivities(clientId: string): Promise<ActivityEntry[]> {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      include: { onboarding: true },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }

    const loanRequests = await this.prisma.loanRequest.findMany({ where: { clientId } });
    const loanRequestIds = loanRequests.map((loanRequest) => loanRequest.id);

    const clientAuditLogs = await this.prisma.auditLog.findMany({
      where: { targetType: 'Client', targetId: clientId },
    });
    const loanRequestAuditLogs =
      loanRequestIds.length > 0
        ? await this.prisma.auditLog.findMany({
            where: { targetType: 'LoanRequest', targetId: { in: loanRequestIds } },
          })
        : [];
    const sessions = await this.prisma.session.findMany({
      where: { principalType: SessionPrincipalType.CLIENT, principalId: clientId },
    });
    const walletEntries = await this.prisma.walletEntry.findMany({
      where: { clientId, actorType: AuditActorType.CLIENT },
    });

    const entries: ActivityEntry[] = [];

    for (const log of [...clientAuditLogs, ...loanRequestAuditLogs]) {
      entries.push({ timestamp: log.createdAt, type: log.action, description: log.action, source: 'AUDIT_LOG' });
    }

    for (const loanRequest of loanRequests) {
      entries.push({
        timestamp: loanRequest.createdAt,
        type: 'loan-request.created',
        description: `Loan request submitted for ₦${loanRequest.amount}`,
        source: 'LOAN_REQUEST',
      });
      if (loanRequest.confirmedAt) {
        entries.push({
          timestamp: loanRequest.confirmedAt,
          type: 'loan-request.confirmed',
          description: 'Loan request confirmed via SMS',
          source: 'LOAN_REQUEST',
        });
      }
    }

    for (const session of sessions) {
      entries.push({
        timestamp: session.createdAt,
        type: 'session.created',
        description: 'Client logged in',
        source: 'SESSION',
      });
    }

    for (const walletEntry of walletEntries) {
      entries.push({
        timestamp: walletEntry.createdAt,
        type: `wallet.${walletEntry.direction.toLowerCase()}`,
        description: walletEntry.description,
        source: 'WALLET',
      });
    }

    if (client.onboarding) {
      entries.push({
        timestamp: client.onboarding.updatedAt,
        type: 'onboarding.step',
        description: `Onboarding step: ${client.onboarding.step}`,
        source: 'ONBOARDING',
      });
    }

    return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
}

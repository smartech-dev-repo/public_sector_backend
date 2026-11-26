// src/agent-profile/agent-profile.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AgentProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(agentId: string) {
    const agent = await this.prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      include: { reviewedByAdmin: { select: { id: true, fullName: true, email: true } } },
    });
    return {
      id: agent.id,
      email: agent.email,
      phone: agent.phone,
      fullName: agent.fullName,
      address: agent.address,
      status: agent.status,
      canOnboardClients: agent.canOnboardClients,
      mustChangePassword: agent.mustChangePassword,
      hasLoggedIn: agent.hasLoggedIn,
      reviewedByAdmin: agent.reviewedByAdmin,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  }
}

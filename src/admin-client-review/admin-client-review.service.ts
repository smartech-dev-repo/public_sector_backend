import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ClientStatus, OnboardingStep } from '../generated/prisma/client';

interface FailureReasons {
  identityVerified?: boolean;
  faceMatchPassed?: boolean;
}

@Injectable()
export class AdminClientReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async list(status?: ClientStatus) {
    return this.prisma.client.findMany({
      where: status ? { status } : undefined,
      include: { onboarding: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findById(id: string) {
    const client = await this.prisma.client.findUnique({
      where: { id },
      include: { onboarding: true },
    });
    if (!client) {
      throw new NotFoundException('Client not found');
    }
    return client;
  }

  async approve(id: string, adminId: string) {
    const client = await this.findById(id);
    if (client.status !== ClientStatus.MANUAL_REVIEW) {
      throw new ConflictException(`Client is not in MANUAL_REVIEW (currently ${client.status})`);
    }

    await this.prisma.clientOnboarding.update({
      where: { clientId: id },
      data: {
        step: OnboardingStep.COMPLETED,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });

    return this.prisma.client.update({
      where: { id },
      data: { status: ClientStatus.VERIFIED },
    });
  }

  async retry(id: string, adminId: string, note: string) {
    const client = await this.findById(id);
    if (client.status !== ClientStatus.MANUAL_REVIEW) {
      throw new ConflictException(`Client is not in MANUAL_REVIEW (currently ${client.status})`);
    }
    if (!client.onboarding) {
      throw new ConflictException('Client has no onboarding record to retry');
    }

    const failureReasons = client.onboarding.failureReasons as FailureReasons | null;
    const identityFailed = failureReasons?.identityVerified === false;

    const resetData = identityFailed
      ? {
          step: OnboardingStep.IPPIS_LINKED,
          bvn: null,
          nin: null,
          bvnSelfie: null,
          ninSelfie: null,
          identityVerified: null,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        }
      : {
          step: OnboardingStep.IDENTITY_SUBMITTED,
          liveSelfieKey: null,
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
        };

    await this.prisma.clientOnboarding.update({
      where: { clientId: id },
      data: {
        ...resetData,
        failureReasons: null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });

    return this.prisma.client.update({
      where: { id },
      data: { status: ClientStatus.PENDING_IPPIS },
    });
  }
}

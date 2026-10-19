import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { narrowIppisRecord } from '../client-onboarding/narrow-ippis-record.util';
import { computeLengthOfService } from '../client-onboarding/length-of-service.util';
import { OnboardingStep, SessionPrincipalType } from '../generated/prisma/client';

@Injectable()
export class ClientProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async getProfile(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({
      where: { id: clientId },
      include: { onboarding: { include: { ippisRecord: true } } },
    });

    const [balance, hasActiveLoan, activeSessionCount] = await Promise.all([
      this.walletService.getBalance(clientId),
      this.clientLoansService.hasActiveLoan(clientId),
      this.prisma.session.count({
        where: {
          principalType: SessionPrincipalType.CLIENT,
          principalId: clientId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);

    return {
      id: client.id,
      phone: client.phone,
      email: client.email,
      status: client.status,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      onboarding: client.onboarding
        ? {
            step: client.onboarding.step,
            completed: client.onboarding.step === OnboardingStep.COMPLETED,
            employeeName: client.onboarding.employeeName,
            agency: client.onboarding.agency,
            lengthOfService: computeLengthOfService(client.onboarding.ippisRecord?.hireDate ?? null),
            identityVerified: client.onboarding.identityVerified,
            faceMatchPassed: client.onboarding.faceMatchPassed,
            ippisRecord: narrowIppisRecord(client.onboarding.ippisRecord),
          }
        : null,
      wallet: { balance },
      hasActiveLoan,
      activeSessionCount,
    };
  }
}

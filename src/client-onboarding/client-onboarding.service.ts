import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FACE_VERIFICATION_PROVIDER, FaceVerificationProvider } from '../face-verification/face-verification-provider.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientStatus, OnboardingStep } from '../generated/prisma/client';

@Injectable()
export class ClientOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityVerificationService: IdentityVerificationService,
    @Inject(FACE_VERIFICATION_PROVIDER) private readonly faceVerificationProvider: FaceVerificationProvider,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  private async requireOnboarding(clientId: string) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (!onboarding) {
      throw new ConflictException('Client has not started IPPIS linking yet');
    }
    return onboarding;
  }

  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      throw new ConflictException('Onboarding already started for this client');
    }

    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const alreadyLinked = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (alreadyLinked) {
      throw new ConflictException('This IPPIS record is already linked to another client');
    }

    return this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        step: OnboardingStep.IPPIS_LINKED,
      },
    });
  }

  async submitIdentity(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }

    const [bvnResult, ninResult] = await Promise.all([
      this.identityVerificationService.lookupBvn(bvn),
      this.identityVerificationService.lookupNin(nin),
    ]);

    const bvnSelfieKey = `client-onboarding/${clientId}/bvn-selfie.jpg`;
    const ninSelfieKey = `client-onboarding/${clientId}/nin-selfie.jpg`;
    await this.fileStorageProvider.putObject(bvnSelfieKey, Buffer.from(bvnResult.photoBase64, 'base64'));
    await this.fileStorageProvider.putObject(ninSelfieKey, Buffer.from(ninResult.photoBase64, 'base64'));

    const identityVerified = Boolean(bvnResult.firstName) && Boolean(ninResult.firstName);

    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        bvn,
        nin,
        bvnSelfie: bvnSelfieKey,
        ninSelfie: ninSelfieKey,
        identityVerified,
        step: OnboardingStep.IDENTITY_SUBMITTED,
      },
    });
  }

  async submitFaceMatch(clientId: string, selfieBuffer: Buffer) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED) {
      throw new ConflictException(`Expected step IDENTITY_SUBMITTED, but client is at ${onboarding.step}`);
    }

    const liveSelfieKey = `client-onboarding/${clientId}/live-selfie.jpg`;
    await this.fileStorageProvider.putObject(liveSelfieKey, selfieBuffer);

    const [bvnMatch, ninMatch] = await Promise.all([
      this.faceVerificationProvider.compare(onboarding.bvnSelfie!, liveSelfieKey),
      this.faceVerificationProvider.compare(onboarding.ninSelfie!, liveSelfieKey),
    ]);

    const faceMatchPassed = bvnMatch.passed && ninMatch.passed;
    const completed = Boolean(onboarding.identityVerified) && faceMatchPassed;

    const updated = await this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        liveSelfieKey,
        faceMatchBvnScore: bvnMatch.score,
        faceMatchNinScore: ninMatch.score,
        faceMatchPassed,
        step: completed ? OnboardingStep.COMPLETED : OnboardingStep.FACE_MATCH_PENDING,
        failureReasons: completed
          ? null
          : { identityVerified: onboarding.identityVerified, faceMatchPassed },
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: completed ? ClientStatus.VERIFIED : ClientStatus.MANUAL_REVIEW },
    });

    return updated;
  }

  async getStatus(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    return {
      step: onboarding?.step ?? OnboardingStep.PHONE_VERIFIED,
      clientStatus: client.status,
      onboarding,
    };
  }
}

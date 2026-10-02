import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { IdentityLookupResult } from '../identity-verification/identity-verification-provider.interface';
import { FACE_VERIFICATION_PROVIDER, FaceVerificationProvider } from '../face-verification/face-verification-provider.interface';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientDocumentType, ClientStatus, OnboardingStep } from '../generated/prisma/client';
import { computeLengthOfService } from './length-of-service.util';

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

  private async createOnboardingRecord(
    clientId: string,
    ippisRecord: {
      id: string;
      employeeName: string;
      agency: string;
      bankName: string | null;
      accountNumber: string | null;
      employeeStatus: string | null;
      legacyId: string | null;
      maritalStatus: string | null;
    },
    onboardedById?: string,
  ) {
    const onboarding = await this.prisma.clientOnboarding.create({
      data: {
        clientId,
        ippisRecordId: ippisRecord.id,
        employeeName: ippisRecord.employeeName,
        agency: ippisRecord.agency,
        bankName: ippisRecord.bankName,
        accountNumber: ippisRecord.accountNumber,
        employeeStatus: ippisRecord.employeeStatus,
        legacyId: ippisRecord.legacyId,
        maritalStatus: ippisRecord.maritalStatus,
        step: OnboardingStep.IPPIS_LINKED,
        onboardedById,
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: ClientStatus.PENDING_IPPIS },
    });

    return onboarding;
  }

  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      return existing;
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

    return this.createOnboardingRecord(clientId, ippisRecord);
  }

  async adminStartOnboarding(ippisNumber: string, adminId: string) {
    const ippisRecord = await this.prisma.ippisRecord.findFirst({
      where: { staffId: { equals: ippisNumber, mode: 'insensitive' } },
    });
    if (!ippisRecord) {
      throw new NotFoundException('IPPIS number not found');
    }

    const existing = await this.prisma.clientOnboarding.findUnique({
      where: { ippisRecordId: ippisRecord.id },
    });
    if (existing) {
      return existing;
    }

    if (!ippisRecord.phone) {
      throw new UnprocessableEntityException(
        'No phone number on file for this IPPIS record — cannot resolve a client',
      );
    }

    const client = await this.prisma.client.upsert({
      where: { phone: ippisRecord.phone },
      update: {},
      create: { phone: ippisRecord.phone, createdById: adminId },
    });

    return this.createOnboardingRecord(client.id, ippisRecord, adminId);
  }

  private async lookupIdentity(bvn: string, nin: string) {
    const [bvnResult, ninResult] = await Promise.all([
      this.identityVerificationService.lookupBvn(bvn),
      this.identityVerificationService.lookupNin(nin),
    ]);
    const identityVerified = Boolean(bvnResult.firstName) && Boolean(ninResult.firstName);
    return { bvnResult, ninResult, identityVerified };
  }

  private async saveIdentity(
    clientId: string,
    onboarding: { id: string },
    bvn: string,
    nin: string,
    bvnResult: IdentityLookupResult,
    ninResult: IdentityLookupResult,
    identityVerified: boolean,
  ) {
    const bvnSelfieKey = `client-onboarding/${clientId}/bvn-selfie.jpg`;
    const ninSelfieKey = `client-onboarding/${clientId}/nin-selfie.jpg`;
    await this.fileStorageProvider.putObject(bvnSelfieKey, Buffer.from(bvnResult.photoBase64, 'base64'));
    await this.fileStorageProvider.putObject(ninSelfieKey, Buffer.from(ninResult.photoBase64, 'base64'));

    const step = await this.determineStepAfterIdentity(onboarding.id);

    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        bvn,
        nin,
        bvnSelfie: bvnSelfieKey,
        ninSelfie: ninSelfieKey,
        identityVerified,
        step,
        identityDateOfBirth: bvnResult.dateOfBirth ? new Date(bvnResult.dateOfBirth) : null,
        identityGender: bvnResult.gender,
        identityPhoneNumber: bvnResult.phoneNumber,
        stateOfOrigin: bvnResult.stateOfOrigin,
        lgaOfOrigin: bvnResult.lgaOfOrigin,
        stateOfResidence: bvnResult.stateOfResidence,
        lgaOfResidence: bvnResult.lgaOfResidence,
        address: ninResult.address,
        city: ninResult.city,
      },
    });
  }

  async submitIdentity(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }
    const { bvnResult, ninResult, identityVerified } = await this.lookupIdentity(bvn, nin);
    return this.saveIdentity(clientId, onboarding, bvn, nin, bvnResult, ninResult, identityVerified);
  }

  async submitIdentityVerified(clientId: string, bvn: string, nin: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IPPIS_LINKED) {
      throw new ConflictException(`Expected step IPPIS_LINKED, but client is at ${onboarding.step}`);
    }
    const { bvnResult, ninResult, identityVerified } = await this.lookupIdentity(bvn, nin);
    if (!identityVerified) {
      throw new UnprocessableEntityException('BVN/NIN verification failed — identity could not be confirmed');
    }
    return this.saveIdentity(clientId, onboarding, bvn, nin, bvnResult, ninResult, identityVerified);
  }

  async determineStepAfterIdentity(onboardingId: string): Promise<OnboardingStep> {
    const documentCount = await this.prisma.clientDocument.count({
      where: { clientOnboardingId: onboardingId },
    });
    return documentCount >= Object.values(ClientDocumentType).length
      ? OnboardingStep.DOCUMENTS_SUBMITTED
      : OnboardingStep.IDENTITY_SUBMITTED;
  }

  async uploadDocument(clientId: string, documentType: ClientDocumentType, file: Express.Multer.File) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED && onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
      throw new ConflictException(
        `Expected step IDENTITY_SUBMITTED or DOCUMENTS_SUBMITTED, but client is at ${onboarding.step}`,
      );
    }

    const storageKey = `client-onboarding/${clientId}/documents/${documentType.toLowerCase()}${extname(file.originalname)}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);

    const document = await this.prisma.clientDocument.upsert({
      where: { clientOnboardingId_documentType: { clientOnboardingId: onboarding.id, documentType } },
      create: { clientOnboardingId: onboarding.id, documentType, storageKey },
      update: { storageKey, uploadedAt: new Date() },
    });

    const nextStep = await this.determineStepAfterIdentity(onboarding.id);
    if (nextStep === OnboardingStep.DOCUMENTS_SUBMITTED && onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
      await this.prisma.clientOnboarding.update({ where: { clientId }, data: { step: nextStep } });
    }

    return document;
  }

  private async completeFaceMatch(
    clientId: string,
    onboarding: { identityVerified: boolean | null; bvnSelfie: string | null; ninSelfie: string | null },
    liveSelfieKey: string,
  ) {
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

  async submitFaceMatch(clientId: string, selfieBuffer: Buffer) {
    const onboarding = await this.requireOnboarding(clientId);
    if (
      onboarding.step !== OnboardingStep.IDENTITY_SUBMITTED &&
      onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED &&
      onboarding.step !== OnboardingStep.COMPLETED
    ) {
      throw new ConflictException(
        `Expected step IDENTITY_SUBMITTED, DOCUMENTS_SUBMITTED, or COMPLETED, but client is at ${onboarding.step}`,
      );
    }

    const liveSelfieKey = `client-onboarding/${clientId}/live-selfie.jpg`;
    await this.fileStorageProvider.putObject(liveSelfieKey, selfieBuffer);

    return this.completeFaceMatch(clientId, onboarding, liveSelfieKey);
  }

  async submitFaceMatchFromPassportPhoto(clientId: string) {
    const onboarding = await this.requireOnboarding(clientId);
    if (onboarding.step !== OnboardingStep.DOCUMENTS_SUBMITTED) {
      throw new ConflictException(
        `Expected step DOCUMENTS_SUBMITTED, but client is at ${onboarding.step}`,
      );
    }

    const passportDoc = await this.prisma.clientDocument.findUnique({
      where: {
        clientOnboardingId_documentType: {
          clientOnboardingId: onboarding.id,
          documentType: ClientDocumentType.PASSPORT_PHOTO,
        },
      },
    });
    if (!passportDoc) {
      throw new ConflictException('Passport photo has not been uploaded yet');
    }
    if (passportDoc.storageKey.toLowerCase().endsWith('.pdf')) {
      throw new UnprocessableEntityException(
        'Passport photo was uploaded as a PDF — an image (JPEG/PNG) is required for face comparison',
      );
    }

    return this.completeFaceMatch(clientId, onboarding, passportDoc.storageKey);
  }

  async getStatus(clientId: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    return {
      step: onboarding?.step ?? OnboardingStep.PHONE_VERIFIED,
      clientStatus: client.status,
      onboarding: onboarding
        ? {
            employeeName: onboarding.employeeName,
            agency: onboarding.agency,
            bankName: onboarding.bankName,
            accountNumber: onboarding.accountNumber,
            employeeStatus: onboarding.employeeStatus,
            identityDateOfBirth: onboarding.identityDateOfBirth,
            identityGender: onboarding.identityGender,
            identityPhoneNumber: onboarding.identityPhoneNumber,
            stateOfOrigin: onboarding.stateOfOrigin,
            lgaOfOrigin: onboarding.lgaOfOrigin,
            stateOfResidence: onboarding.stateOfResidence,
            lgaOfResidence: onboarding.lgaOfResidence,
            address: onboarding.address,
            city: onboarding.city,
            zipCode: onboarding.zipCode,
            maritalStatus: onboarding.maritalStatus,
            step: onboarding.step,
          }
        : null,
      lengthOfService: computeLengthOfService(onboarding?.ippisRecord?.hireDate ?? null),
    };
  }

  async updateMaritalStatus(clientId: string, maritalStatus: string) {
    return this.prisma.clientOnboarding.update({
      where: { clientId },
      data: { maritalStatus },
    });
  }
}

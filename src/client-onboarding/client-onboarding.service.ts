import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { extname } from 'path';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { IdentityLookupResult } from '../identity-verification/identity-verification-provider.interface';
import { FaceMatchService } from '../face-verification/face-match.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { ClientDocumentType, ClientStatus, OnboardingStep, Prisma } from '../generated/prisma/client';
import { computeLengthOfService } from './length-of-service.util';
import { normalizeNigerianPhone, phonesTally, validNigerianPhone } from '../common/normalize-nigerian-phone.util';

@Injectable()
export class ClientOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityVerificationService: IdentityVerificationService,
    private readonly faceMatchService: FaceMatchService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  private async narrowOnboarding<
    T extends { bvnSelfie: string | null; ninSelfie: string | null; liveSelfieKey: string | null },
  >(onboarding: T) {
    const { bvnSelfie, ninSelfie, liveSelfieKey, ...rest } = onboarding;
    const [bvnSelfieUrl, ninSelfieUrl, liveSelfieUrl] = await Promise.all([
      bvnSelfie ? this.fileStorageProvider.getSignedDownloadUrl(bvnSelfie) : null,
      ninSelfie ? this.fileStorageProvider.getSignedDownloadUrl(ninSelfie) : null,
      liveSelfieKey ? this.fileStorageProvider.getSignedDownloadUrl(liveSelfieKey) : null,
    ]);
    return { ...rest, bvnSelfieUrl, ninSelfieUrl, liveSelfieUrl };
  }

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
    onboardedByAgentId?: string,
  ) {
    const onboarding = await this.prisma.clientOnboarding
      .create({
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
        onboardedByAgentId,
      },
    })
      .catch((error: unknown) => {
        // The phone's client is already onboarded under a different IPPIS record.
        if (isUniqueConstraintError(error)) {
          throw new ConflictException('This phone number is already registered to another client');
        }
        throw error;
      });

    // Whoever onboards becomes the owner, unless the client already has one.
    const owner = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { assignedAgentId: true, assignedAdminId: true },
    });
    await this.prisma.client.update({
      where: { id: clientId },
      data: {
        status: ClientStatus.PENDING_IPPIS,
        ...(onboardedByAgentId && !owner?.assignedAgentId ? { assignedAgentId: onboardedByAgentId } : {}),
        ...(onboardedById && !owner?.assignedAdminId ? { assignedAdminId: onboardedById } : {}),
      },
    });

    return onboarding;
  }

  private assertPhoneTallies(ippisPhone: string | null, phone: string) {
    if (!ippisPhone) {
      throw new UnprocessableEntityException(
        'No phone number on file for this IPPIS record — update the IPPIS record before onboarding',
      );
    }
    if (!phonesTally(ippisPhone, phone)) {
      throw new UnprocessableEntityException('This phone number does not match the IPPIS record for this IPPIS number');
    }
  }

  // An already-onboarded client is matched on their own phone: a later
  // broadsheet may have changed the IPPIS phone since they enrolled.
  private async assertOnboardedClientPhone(clientId: string, phone: string) {
    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    if (!phonesTally(client.phone, phone)) {
      throw new UnprocessableEntityException('This phone number does not match the client onboarded with this IPPIS number');
    }
  }

  async linkIppis(clientId: string, ippisNumber: string) {
    const existing = await this.prisma.clientOnboarding.findUnique({ where: { clientId } });
    if (existing) {
      return this.narrowOnboarding(existing);
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

    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    this.assertPhoneTallies(ippisRecord.phone, client.phone);

    return this.narrowOnboarding(await this.createOnboardingRecord(clientId, ippisRecord));
  }

  async adminStartOnboarding(ippisNumber: string, phone: string, adminId: string) {
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
      await this.assertOnboardedClientPhone(existing.clientId, phone);
      return this.narrowOnboarding(existing);
    }

    this.assertPhoneTallies(ippisRecord.phone, phone);

    const normalizedPhone = normalizeNigerianPhone(phone);
    const client = await this.prisma.client.upsert({
      where: { phone: normalizedPhone },
      update: {},
      create: { phone: normalizedPhone, createdById: adminId, assignedAdminId: adminId },
    });

    return this.narrowOnboarding(await this.createOnboardingRecord(client.id, ippisRecord, adminId));
  }

  // The agent gives only the IPPIS number. The client is created on the record's phone,
  // so they can log in with that number by OTP and carry on from where the agent stopped.
  async agentStartOnboarding(ippisNumber: string, agentId: string) {
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
      const owner = await this.prisma.client.findUnique({ where: { id: existing.clientId }, select: { assignedAgentId: true } });
      if (existing.onboardedByAgentId === agentId || owner?.assignedAgentId === agentId) {
        return this.narrowOnboarding(existing);
      }
      throw new ConflictException('This client has already been onboarded');
    }

    const phone = ippisRecord.phone && validNigerianPhone(ippisRecord.phone);
    if (!phone) {
      throw new UnprocessableEntityException(
        'This IPPIS record has no valid phone number. Correct it in the broadsheet before onboarding',
      );
    }

    const client = await this.prisma.client.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    return this.narrowOnboarding(await this.createOnboardingRecord(client.id, ippisRecord, undefined, agentId));
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

    const updated = await this.prisma.clientOnboarding.update({
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
    return this.narrowOnboarding(updated);
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

    const url = await this.fileStorageProvider.getSignedDownloadUrl(document.storageKey);
    return { documentType: document.documentType, uploadedAt: document.uploadedAt, url };
  }

  /** The BVN and NIN photos saved at the identity step; an empty buffer if one is missing. */
  private async loadIdPhotos(onboarding: { bvnSelfie: string | null; ninSelfie: string | null }) {
    const load = (key: string | null) =>
      key
        ? this.fileStorageProvider.getObject(key).catch((error: unknown) => {
            if (error instanceof NotFoundException) return Buffer.alloc(0);
            throw error;
          })
        : Promise.resolve(Buffer.alloc(0));
    const [bvn, nin] = await Promise.all([load(onboarding.bvnSelfie), load(onboarding.ninSelfie)]);
    return { bvn, nin };
  }

  /**
   * Compares the photo with the BVN and NIN photos (when face comparison is switched on in the
   * back office), then completes onboarding or sends the client to manual review. An unusable
   * photo (no face, several faces) is refused with 422 before anything is saved, so it can be
   * retaken.
   */
  private async completeFaceMatch(
    clientId: string,
    onboarding: { identityVerified: boolean | null; bvnSelfie: string | null; ninSelfie: string | null },
    photo: Buffer,
    photoKey: string,
    { storePhoto }: { storePhoto: boolean },
  ) {
    const outcome = await this.faceMatchService.verify(photo, () => this.loadIdPhotos(onboarding));
    if (storePhoto) {
      await this.fileStorageProvider.putObject(photoKey, photo);
    }

    // Null when comparison is switched off: onboarding then rests on BVN/NIN verification.
    const faceMatchPassed = outcome.checked ? outcome.passed : null;
    const completed = Boolean(onboarding.identityVerified) && faceMatchPassed !== false;

    const updated = await this.prisma.clientOnboarding.update({
      where: { clientId },
      data: {
        liveSelfieKey: photoKey,
        faceMatchBvnScore: outcome.checked ? outcome.scores.bvn : null,
        faceMatchNinScore: outcome.checked ? outcome.scores.nin : null,
        faceMatchPassed,
        faceMatchMinimumScore: outcome.checked ? outcome.minimumScore : null,
        step: completed ? OnboardingStep.COMPLETED : OnboardingStep.FACE_MATCH_PENDING,
        failureReasons: completed
          ? Prisma.DbNull
          : {
              identityVerified: onboarding.identityVerified,
              faceMatchPassed,
              ...(outcome.checked && !outcome.passed ? { faceMatch: outcome.problems } : {}),
            },
      },
    });

    await this.prisma.client.update({
      where: { id: clientId },
      data: { status: completed ? ClientStatus.VERIFIED : ClientStatus.MANUAL_REVIEW },
    });

    return this.narrowOnboarding(updated);
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
    return this.completeFaceMatch(clientId, onboarding, selfieBuffer, liveSelfieKey, { storePhoto: true });
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

    const passportPhoto = await this.fileStorageProvider.getObject(passportDoc.storageKey);
    return this.completeFaceMatch(clientId, onboarding, passportPhoto, passportDoc.storageKey, { storePhoto: false });
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
    const updated = await this.prisma.clientOnboarding.update({
      where: { clientId },
      data: { maritalStatus },
    });
    return this.narrowOnboarding(updated);
  }
}

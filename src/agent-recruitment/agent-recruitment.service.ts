import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { TokenService } from '../auth/token.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { generateNumericCode } from '../common/generate-numeric-code.util';
import { hashToken } from '../common/opaque-token.util';
import { AgentApplicationStatus, AgentStatus } from '../generated/prisma/client';
import { agentRecruitmentVerificationCodeEmail } from '../email/templates/verification-code-emails';

const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

export interface SubmitApplicationInput {
  fullName: string;
  phone: string;
  gender: string;
  address: string;
  city: string;
  state: string;
  localGovernment: string;
  nin: string;
  coverLetter: string;
}

export interface SubmitApplicationFiles {
  cv: Express.Multer.File;
  passportPhoto: Express.Multer.File;
  identityDocument?: Express.Multer.File;
}

@Injectable()
export class AgentRecruitmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly tokenService: TokenService,
    private readonly identityVerificationService: IdentityVerificationService,
    private readonly configService: ConfigService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async requestCode(email: string): Promise<void> {
    const existingAgent = await this.prisma.agent.findUnique({ where: { email } });
    if (existingAgent) {
      throw new ConflictException('An agent application with this email already exists');
    }

    const length = Number(this.configService.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    const emailCodeHash = hashToken(code);
    const emailCodeExpiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);

    await this.prisma.agentApplication.upsert({
      where: { email },
      update: { emailCodeHash, emailCodeExpiresAt },
      create: { email, emailCodeHash, emailCodeExpiresAt },
    });

    await this.emailService.send({
      to: email,
      ...agentRecruitmentVerificationCodeEmail({ code, ttlMinutes: EMAIL_CODE_TTL_MS / 60000 }),
    });
  }

  async confirmCode(email: string, code: string): Promise<{ applicationToken: string }> {
    const application = await this.prisma.agentApplication.findUnique({ where: { email } });
    if (
      !application ||
      !application.emailCodeHash ||
      !application.emailCodeExpiresAt ||
      application.emailCodeExpiresAt < new Date() ||
      application.emailCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    if (application.status === AgentApplicationStatus.EMAIL_PENDING) {
      await this.prisma.agentApplication.update({
        where: { id: application.id },
        data: {
          status: AgentApplicationStatus.EMAIL_VERIFIED,
          emailVerifiedAt: new Date(),
          emailCodeHash: null,
          emailCodeExpiresAt: null,
        },
      });
    } else {
      await this.prisma.agentApplication.update({
        where: { id: application.id },
        data: { emailCodeHash: null, emailCodeExpiresAt: null },
      });
    }

    return { applicationToken: this.tokenService.signAgentApplicationToken(application.id) };
  }

  async verifyNin(
    applicationId: string,
    nin: string,
  ): Promise<{ ninVerified: boolean; ninVerifiedName: string | null }> {
    const application = await this.prisma.agentApplication.findUniqueOrThrow({ where: { id: applicationId } });
    if (application.status === AgentApplicationStatus.SUBMITTED) {
      throw new ConflictException('This application has already been submitted');
    }

    const result = await this.identityVerificationService.lookupNin(nin);
    const ninVerified = Boolean(result.firstName);
    const ninVerifiedName = ninVerified ? `${result.firstName} ${result.lastName}`.trim() : null;

    await this.prisma.agentApplication.update({
      where: { id: applicationId },
      data: { nin, ninVerified, ninVerifiedName },
    });

    return { ninVerified, ninVerifiedName };
  }

  async getStatus(applicationId: string) {
    const application = await this.prisma.agentApplication.findUniqueOrThrow({
      where: { id: applicationId },
      include: { submittedAgent: true },
    });

    if (application.status === AgentApplicationStatus.SUBMITTED && application.submittedAgent) {
      return {
        status: application.submittedAgent.status,
        reviewedAt: application.submittedAgent.reviewedAt,
        rejectionReason: application.submittedAgent.rejectionReason,
      };
    }

    return {
      status: application.status,
      fullName: application.fullName,
      phone: application.phone,
      gender: application.gender,
      address: application.address,
      city: application.city,
      state: application.state,
      localGovernment: application.localGovernment,
      nin: application.nin,
      ninVerified: application.ninVerified,
      ninVerifiedName: application.ninVerifiedName,
      coverLetter: application.coverLetter,
      hasCv: Boolean(application.cvKey),
      hasPassportPhoto: Boolean(application.passportPhotoKey),
      hasIdentityDocument: Boolean(application.identityDocumentKey),
    };
  }

  async submit(applicationId: string, input: SubmitApplicationInput, files: SubmitApplicationFiles) {
    const application = await this.prisma.agentApplication.findUniqueOrThrow({ where: { id: applicationId } });
    if (application.status === AgentApplicationStatus.SUBMITTED) {
      throw new ConflictException('This application has already been submitted');
    }

    let ninVerified = application.ninVerified;
    let ninVerifiedName = application.ninVerifiedName;
    if (application.nin !== input.nin || application.ninVerified === null) {
      const result = await this.identityVerificationService.lookupNin(input.nin);
      ninVerified = Boolean(result.firstName);
      ninVerifiedName = ninVerified ? `${result.firstName} ${result.lastName}`.trim() : null;
    }

    const agent = await this.prisma.agent.create({
      data: {
        email: application.email,
        phone: input.phone,
        fullName: input.fullName,
        address: input.address,
        gender: input.gender,
        city: input.city,
        state: input.state,
        localGovernment: input.localGovernment,
        nin: input.nin,
        ninVerified,
        ninVerifiedName,
        coverLetter: input.coverLetter,
        cvKey: '',
        status: AgentStatus.PENDING_REVIEW,
      },
    });

    const cvKey = `agent-documents/${agent.id}/cv-${randomUUID()}${extname(files.cv.originalname)}`;
    await this.fileStorageProvider.putObject(cvKey, files.cv.buffer);

    const passportPhotoKey = `agent-documents/${agent.id}/passport-photo-${randomUUID()}${extname(files.passportPhoto.originalname)}`;
    await this.fileStorageProvider.putObject(passportPhotoKey, files.passportPhoto.buffer);

    let identityDocumentKey: string | undefined;
    if (files.identityDocument) {
      identityDocumentKey = `agent-documents/${agent.id}/identity-document-${randomUUID()}${extname(files.identityDocument.originalname)}`;
      await this.fileStorageProvider.putObject(identityDocumentKey, files.identityDocument.buffer);
    }

    const updatedAgent = await this.prisma.agent.update({
      where: { id: agent.id },
      data: { cvKey, passportPhotoKey, identityDocumentKey },
    });

    await this.prisma.agentApplication.update({
      where: { id: applicationId },
      data: {
        status: AgentApplicationStatus.SUBMITTED,
        submittedAgentId: agent.id,
        fullName: input.fullName,
        phone: input.phone,
        gender: input.gender,
        address: input.address,
        city: input.city,
        state: input.state,
        localGovernment: input.localGovernment,
        nin: input.nin,
        ninVerified,
        ninVerifiedName,
        coverLetter: input.coverLetter,
        cvKey,
        passportPhotoKey,
        identityDocumentKey,
      },
    });

    return {
      id: updatedAgent.id,
      email: updatedAgent.email,
      fullName: updatedAgent.fullName,
      status: updatedAgent.status,
      createdAt: updatedAgent.createdAt,
    };
  }
}

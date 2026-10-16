import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRecruitmentService } from './agent-recruitment.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { TokenService } from '../auth/token.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { hashToken } from '../common/opaque-token.util';

describe('AgentRecruitmentService', () => {
  let service: AgentRecruitmentService;
  let prisma: {
    agent: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    agentApplication: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; upsert: jest.Mock; update: jest.Mock };
  };
  let emailService: { send: jest.Mock };
  let tokenService: { signAgentApplicationToken: jest.Mock };
  let identityVerificationService: { lookupNin: jest.Mock };
  let configService: { get: jest.Mock };
  let fileStorageProvider: { putObject: jest.Mock };

  beforeEach(() => {
    prisma = {
      agent: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      agentApplication: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
    };
    emailService = { send: jest.fn().mockResolvedValue(undefined) };
    tokenService = { signAgentApplicationToken: jest.fn().mockReturnValue('app-token') };
    identityVerificationService = { lookupNin: jest.fn() };
    configService = { get: jest.fn().mockReturnValue(undefined) };
    fileStorageProvider = { putObject: jest.fn().mockResolvedValue(undefined) };

    service = new AgentRecruitmentService(
      prisma as unknown as PrismaService,
      emailService as unknown as EmailService,
      tokenService as unknown as TokenService,
      identityVerificationService as unknown as IdentityVerificationService,
      configService as unknown as ConfigService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('requestCode', () => {
    it('rejects when an Agent already exists with this email', async () => {
      prisma.agent.findUnique.mockResolvedValue({ id: 'agent-1' });
      await expect(service.requestCode('taken@example.com')).rejects.toThrow(ConflictException);
      expect(prisma.agentApplication.upsert).not.toHaveBeenCalled();
    });

    it('upserts the draft and emails the code', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);
      prisma.agentApplication.upsert.mockResolvedValue({ id: 'app-1' });

      await service.requestCode('new@example.com');

      expect(prisma.agentApplication.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'new@example.com' },
          create: expect.objectContaining({ email: 'new@example.com' }),
        }),
      );
      expect(emailService.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@example.com' }));
    });
  });

  describe('confirmCode', () => {
    it('rejects when no draft exists for the email', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue(null);
      await expect(service.confirmCode('x@example.com', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired code', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() - 1000),
        status: 'EMAIL_PENDING',
      });
      await expect(service.confirmCode('x@example.com', '123456')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a wrong code', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() + 100000),
        status: 'EMAIL_PENDING',
      });
      await expect(service.confirmCode('x@example.com', '000000')).rejects.toThrow(UnauthorizedException);
    });

    it('marks EMAIL_VERIFIED on first confirmation and issues a token', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() + 100000),
        status: 'EMAIL_PENDING',
      });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.confirmCode('x@example.com', '123456');

      expect(prisma.agentApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: expect.objectContaining({ status: 'EMAIL_VERIFIED', emailCodeHash: null, emailCodeExpiresAt: null }),
      });
      expect(tokenService.signAgentApplicationToken).toHaveBeenCalledWith('app-1');
      expect(result).toEqual({ applicationToken: 'app-token' });
    });

    it('re-issues a token without resetting status when already EMAIL_VERIFIED', async () => {
      prisma.agentApplication.findUnique.mockResolvedValue({
        id: 'app-1',
        emailCodeHash: hashToken('123456'),
        emailCodeExpiresAt: new Date(Date.now() + 100000),
        status: 'EMAIL_VERIFIED',
      });
      prisma.agentApplication.update.mockResolvedValue({});

      await service.confirmCode('x@example.com', '123456');

      expect(prisma.agentApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { emailCodeHash: null, emailCodeExpiresAt: null },
      });
    });
  });

  describe('verifyNin', () => {
    it('rejects when the application has already been submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'SUBMITTED' });
      await expect(service.verifyNin('app-1', '12345678901')).rejects.toThrow(ConflictException);
    });

    it('stores and returns the verified name', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'EMAIL_VERIFIED' });
      identityVerificationService.lookupNin.mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.verifyNin('app-1', '12345678901');

      expect(result).toEqual({ ninVerified: true, ninVerifiedName: 'Jane Doe' });
      expect(prisma.agentApplication.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: { nin: '12345678901', ninVerified: true, ninVerifiedName: 'Jane Doe' },
      });
    });

    it('returns ninVerified false without a name when the lookup finds nothing', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'EMAIL_VERIFIED' });
      identityVerificationService.lookupNin.mockResolvedValue({ firstName: '', lastName: '' });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.verifyNin('app-1', '00000000000');

      expect(result).toEqual({ ninVerified: false, ninVerifiedName: null });
    });
  });

  describe('getStatus', () => {
    it('returns the draft fields when not yet submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        status: 'EMAIL_VERIFIED',
        fullName: 'Jane Doe',
        phone: '+2348000000000',
        gender: 'Female',
        address: '1 St',
        city: 'Lagos',
        state: 'Lagos',
        localGovernment: 'Ikeja',
        nin: '12345678901',
        ninVerified: true,
        ninVerifiedName: 'Jane Doe',
        coverLetter: 'Hello',
        cvKey: 'agent-documents/x/cv.pdf',
        passportPhotoKey: null,
        identityDocumentKey: null,
        submittedAgent: null,
      });

      const result = await service.getStatus('app-1');

      expect(result).toEqual(
        expect.objectContaining({
          status: 'EMAIL_VERIFIED',
          hasCv: true,
          hasPassportPhoto: false,
          hasIdentityDocument: false,
        }),
      );
    });

    it('returns the real Agent status once submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        status: 'SUBMITTED',
        submittedAgent: { status: 'PENDING_REVIEW', reviewedAt: null, rejectionReason: null },
      });

      const result = await service.getStatus('app-1');

      expect(result).toEqual({ status: 'PENDING_REVIEW', reviewedAt: null, rejectionReason: null });
    });
  });

  describe('submit', () => {
    const input = {
      fullName: 'Jane Doe',
      phone: '+2348000000000',
      gender: 'Female',
      address: '1 St',
      city: 'Lagos',
      state: 'Lagos',
      localGovernment: 'Ikeja',
      nin: '12345678901',
      coverLetter: 'Hello',
    };
    const files = {
      cv: { originalname: 'cv.pdf', buffer: Buffer.from('cv') } as Express.Multer.File,
      passportPhoto: { originalname: 'photo.jpg', buffer: Buffer.from('photo') } as Express.Multer.File,
    };

    it('rejects when the application has already been submitted', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({ id: 'app-1', status: 'SUBMITTED' });
      await expect(service.submit('app-1', input, files)).rejects.toThrow(ConflictException);
    });

    it('auto-verifies NIN when not already verified, then creates the Agent and uploads files', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        id: 'app-1',
        status: 'EMAIL_VERIFIED',
        email: 'jane@example.com',
        nin: null,
        ninVerified: null,
        ninVerifiedName: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({ firstName: 'Jane', lastName: 'Doe' });
      prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
      prisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
      prisma.agentApplication.update.mockResolvedValue({});

      const result = await service.submit('app-1', input, files);

      expect(identityVerificationService.lookupNin).toHaveBeenCalledWith('12345678901');
      expect(prisma.agent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'jane@example.com', ninVerified: true }) }),
      );
      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
      expect(prisma.agentApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'app-1' },
          data: expect.objectContaining({ status: 'SUBMITTED', submittedAgentId: 'agent-1' }),
        }),
      );
      expect(result).toEqual({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
    });

    it('skips re-verifying NIN when already verified for this exact value', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        id: 'app-1',
        status: 'EMAIL_VERIFIED',
        email: 'jane@example.com',
        nin: '12345678901',
        ninVerified: true,
        ninVerifiedName: 'Jane Doe',
      });
      prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
      prisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
      prisma.agentApplication.update.mockResolvedValue({});

      await service.submit('app-1', input, files);

      expect(identityVerificationService.lookupNin).not.toHaveBeenCalled();
    });

    it('uploads an optional identity document when provided', async () => {
      prisma.agentApplication.findUniqueOrThrow.mockResolvedValue({
        id: 'app-1',
        status: 'EMAIL_VERIFIED',
        email: 'jane@example.com',
        nin: '12345678901',
        ninVerified: true,
        ninVerifiedName: 'Jane Doe',
      });
      prisma.agent.create.mockResolvedValue({ id: 'agent-1' });
      prisma.agent.update.mockResolvedValue({
        id: 'agent-1',
        email: 'jane@example.com',
        fullName: 'Jane Doe',
        status: 'PENDING_REVIEW',
        createdAt: new Date('2026-01-01'),
      });
      prisma.agentApplication.update.mockResolvedValue({});

      await service.submit('app-1', input, {
        ...files,
        identityDocument: { originalname: 'id.pdf', buffer: Buffer.from('id') } as Express.Multer.File,
      });

      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(3);
    });
  });
});

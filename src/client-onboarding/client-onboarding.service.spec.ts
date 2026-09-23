import { ConflictException, NotFoundException } from '@nestjs/common';
import { ClientOnboardingService } from './client-onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FaceVerificationProvider } from '../face-verification/face-verification-provider.interface';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('ClientOnboardingService', () => {
  let service: ClientOnboardingService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    ippisRecord: { findFirst: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    clientDocument: { count: jest.Mock; upsert: jest.Mock };
  };
  let identityVerificationService: { lookupBvn: jest.Mock; lookupNin: jest.Mock };
  let faceVerificationProvider: { compare: jest.Mock };
  let fileStorageProvider: { putObject: jest.Mock };

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      ippisRecord: { findFirst: jest.fn() },
      client: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
      clientDocument: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn() },
    };
    identityVerificationService = { lookupBvn: jest.fn(), lookupNin: jest.fn() };
    faceVerificationProvider = { compare: jest.fn() };
    fileStorageProvider = { putObject: jest.fn().mockResolvedValue(undefined) };

    service = new ClientOnboardingService(
      prisma as unknown as PrismaService,
      identityVerificationService as unknown as IdentityVerificationService,
      faceVerificationProvider as unknown as FaceVerificationProvider,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('linkIppis', () => {
    it('rejects when onboarding already started for this client', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(ConflictException);
    });

    it('rejects when the IPPIS number is not found', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(NotFoundException);
    });

    it('rejects when the IPPIS record is already linked to another client', async () => {
      prisma.clientOnboarding.findUnique
        .mockResolvedValueOnce(null) // no existing onboarding for this client
        .mockResolvedValueOnce({ id: 'other' }); // already linked to someone else
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', employeeName: 'X', agency: 'NPF' });
      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(ConflictException);
    });

    it('creates a ClientOnboarding row pulling the matched IppisRecord fields', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
        maritalStatus: 'Married',
      });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.linkIppis('client-1', 'NPF/1');

      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          employeeName: 'Jane Doe',
          agency: 'NPF',
          bankName: 'GTBank',
          accountNumber: '0123456789',
          employeeStatus: 'ACTIVE',
          legacyId: 'LEGACY-001',
          maritalStatus: 'Married',
          step: 'IPPIS_LINKED',
        }),
      });
    });

    it('sets Client.status to PENDING_IPPIS once linked', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
      });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.linkIppis('client-1', 'NPF/1');

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'PENDING_IPPIS' },
      });
    });
  });

  describe('submitIdentity', () => {
    it('rejects when the client has no onboarding row yet', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.submitIdentity('client-1', '12345678901', '12345678901')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client is not at the IPPIS_LINKED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IDENTITY_SUBMITTED' });
      await expect(service.submitIdentity('client-1', '12345678901', '12345678901')).rejects.toThrow(ConflictException);
    });

    it('looks up BVN and NIN, stores both photos, marks identityVerified, and persists the extended identity fields', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-01', phoneNumber: '08011111111', photoBase64: 'YnZuLXBob3Rv',
        gender: 'Female', stateOfOrigin: 'Lagos', lgaOfOrigin: 'Ikeja', stateOfResidence: 'Abuja', lgaOfResidence: 'AMAC',
        maritalStatus: 'Single', address: null, city: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-01', phoneNumber: '08011111111', photoBase64: 'bmluLXBob3Rv',
        gender: 'Female', stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: '12 Example Street', city: 'Wuse',
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitIdentity('client-1', '12345678901', '98765432109');

      expect(fileStorageProvider.putObject).toHaveBeenCalledTimes(2);
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({
          bvn: '12345678901',
          nin: '98765432109',
          identityVerified: true,
          step: 'IDENTITY_SUBMITTED',
          identityDateOfBirth: new Date('1990-01-01'),
          identityGender: 'Female',
          identityPhoneNumber: '08011111111',
          stateOfOrigin: 'Lagos',
          lgaOfOrigin: 'Ikeja',
          stateOfResidence: 'Abuja',
          lgaOfResidence: 'AMAC',
          address: '12 Example Street',
          city: 'Wuse',
        }),
      });
    });

    it('stores a null identityDateOfBirth when Dojah returns no date of birth', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: null, phoneNumber: null, photoBase64: 'YnZuLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: 'Jane', lastName: 'Doe', dateOfBirth: null, phoneNumber: null, photoBase64: 'bmluLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitIdentity('client-1', '12345678901', '98765432109');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ identityDateOfBirth: null }) }),
      );
    });
  });

  describe('determineStepAfterIdentity', () => {
    it('returns IDENTITY_SUBMITTED when fewer than 4 documents exist', async () => {
      prisma.clientDocument.count.mockResolvedValue(3);
      const result = await service.determineStepAfterIdentity('onboarding-1');
      expect(result).toBe('IDENTITY_SUBMITTED');
    });

    it('returns DOCUMENTS_SUBMITTED when all 4 documents exist', async () => {
      prisma.clientDocument.count.mockResolvedValue(4);
      const result = await service.determineStepAfterIdentity('onboarding-1');
      expect(result).toBe('DOCUMENTS_SUBMITTED');
    });
  });

  describe('uploadDocument', () => {
    const file = { originalname: 'nin.jpg', buffer: Buffer.from('fake') } as Express.Multer.File;

    it('rejects when the client has no onboarding row', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      await expect(service.uploadDocument('client-1', 'NIN_CARD' as never, file)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects when the client is not at IDENTITY_SUBMITTED or DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      await expect(service.uploadDocument('client-1', 'NIN_CARD' as never, file)).rejects.toThrow(
        ConflictException,
      );
    });

    it('uploads a document and does not advance the step when fewer than 4 documents exist', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      prisma.clientDocument.upsert.mockResolvedValue({ id: 'doc-1' });
      prisma.clientDocument.count.mockResolvedValue(1);

      await service.uploadDocument('client-1', 'NIN_CARD' as never, file);

      expect(fileStorageProvider.putObject).toHaveBeenCalledWith(
        'client-onboarding/client-1/documents/nin_card.jpg',
        file.buffer,
      );
      expect(prisma.clientDocument.upsert).toHaveBeenCalledWith({
        where: { clientOnboardingId_documentType: { clientOnboardingId: 'onboarding-1', documentType: 'NIN_CARD' } },
        create: {
          clientOnboardingId: 'onboarding-1',
          documentType: 'NIN_CARD',
          storageKey: 'client-onboarding/client-1/documents/nin_card.jpg',
        },
        update: {
          storageKey: 'client-onboarding/client-1/documents/nin_card.jpg',
          uploadedAt: expect.any(Date),
        },
      });
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
    });

    it('advances the step to DOCUMENTS_SUBMITTED once the 4th document is uploaded', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      prisma.clientDocument.upsert.mockResolvedValue({ id: 'doc-4' });
      prisma.clientDocument.count.mockResolvedValue(4);
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });

      await service.uploadDocument('client-1', 'SIGNATURE' as never, file);

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: { step: 'DOCUMENTS_SUBMITTED' },
      });
    });

    it('does not re-trigger the step update when already at DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });
      prisma.clientDocument.upsert.mockResolvedValue({ id: 'doc-1' });
      prisma.clientDocument.count.mockResolvedValue(4);

      await service.uploadDocument('client-1', 'NIN_CARD' as never, file);

      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
    });
  });

  describe('submitFaceMatch', () => {
    it('rejects when the client is not at the IDENTITY_SUBMITTED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IPPIS_LINKED' });
      await expect(service.submitFaceMatch('client-1', Buffer.from('selfie'))).rejects.toThrow(ConflictException);
    });

    it('completes and sets Client VERIFIED when identity and both face matches pass', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'IDENTITY_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      faceVerificationProvider.compare.mockResolvedValue({ score: 0.95, passed: true });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });

    it('completes and sets Client VERIFIED when starting from DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'DOCUMENTS_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      faceVerificationProvider.compare.mockResolvedValue({ score: 0.95, passed: true });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });

    it('routes to MANUAL_REVIEW when a face match fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'IDENTITY_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      faceVerificationProvider.compare
        .mockResolvedValueOnce({ score: 0.95, passed: true })
        .mockResolvedValueOnce({ score: 0.2, passed: false });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'MANUAL_REVIEW' },
      });
    });
  });

  describe('getStatus', () => {
    it('returns PHONE_VERIFIED when no onboarding row exists yet', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'PHONE_VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('client-1');

      expect(result.step).toBe('PHONE_VERIFIED');
    });

    it('returns a null lengthOfService when there is no onboarding row yet', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'PHONE_VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('client-1');

      expect(result.lengthOfService).toBeNull();
    });

    it('computes lengthOfService from the linked IppisRecord\'s hireDate', async () => {
      const now = new Date();
      const hireDate = new Date(now.getFullYear() - 2, now.getMonth(), 1);
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'COMPLETED',
        ippisRecord: { hireDate },
      });

      const result = await service.getStatus('client-1');

      expect(prisma.clientOnboarding.findUnique).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        include: { ippisRecord: true },
      });
      expect(result.lengthOfService).toEqual({ years: 2, months: 0 });
    });

    it('returns a curated onboarding shape without bvn/nin/selfie keys or the raw ippisRecord', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        step: 'COMPLETED',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        identityDateOfBirth: new Date('1990-01-01'),
        identityGender: 'Female',
        identityPhoneNumber: '08011111111',
        stateOfOrigin: 'Lagos',
        lgaOfOrigin: 'Ikeja',
        stateOfResidence: 'Abuja',
        lgaOfResidence: 'AMAC',
        address: '12 Example Street',
        city: 'Wuse',
        zipCode: null,
        maritalStatus: 'Single',
        bvn: '12345678901',
        nin: '98765432109',
        bvnSelfie: 'client-onboarding/client-1/bvn-selfie.jpg',
        ninSelfie: 'client-onboarding/client-1/nin-selfie.jpg',
        liveSelfieKey: 'client-onboarding/client-1/live-selfie.jpg',
        ippisRecord: { hireDate: new Date('2020-01-01') },
      });

      const result = await service.getStatus('client-1');

      expect(result.onboarding).toEqual({
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        identityDateOfBirth: new Date('1990-01-01'),
        identityGender: 'Female',
        identityPhoneNumber: '08011111111',
        stateOfOrigin: 'Lagos',
        lgaOfOrigin: 'Ikeja',
        stateOfResidence: 'Abuja',
        lgaOfResidence: 'AMAC',
        address: '12 Example Street',
        city: 'Wuse',
        zipCode: null,
        maritalStatus: 'Single',
        step: 'COMPLETED',
      });
      expect(result.onboarding).not.toHaveProperty('bvn');
      expect(result.onboarding).not.toHaveProperty('nin');
      expect(result.onboarding).not.toHaveProperty('bvnSelfie');
      expect(result.onboarding).not.toHaveProperty('ninSelfie');
      expect(result.onboarding).not.toHaveProperty('liveSelfieKey');
      expect(result.onboarding).not.toHaveProperty('ippisRecord');
    });

    it('returns a null onboarding view when there is no onboarding row yet', async () => {
      prisma.client.findUniqueOrThrow.mockResolvedValue({ id: 'client-1', status: 'PHONE_VERIFIED' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      const result = await service.getStatus('client-1');

      expect(result.onboarding).toBeNull();
    });
  });

  describe('updateMaritalStatus', () => {
    it('updates the maritalStatus field', async () => {
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', maritalStatus: 'Divorced' });

      const result = await service.updateMaritalStatus('client-1', 'Divorced');

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: { maritalStatus: 'Divorced' },
      });
      expect(result.maritalStatus).toBe('Divorced');
    });
  });
});

import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ClientOnboardingService } from './client-onboarding.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdentityVerificationService } from '../identity-verification/identity-verification.service';
import { FaceMatchService } from '../face-verification/face-match.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('ClientOnboardingService', () => {
  let service: ClientOnboardingService;
  let prisma: {
    clientOnboarding: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
    ippisRecord: { findFirst: jest.Mock };
    client: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock; update: jest.Mock; upsert: jest.Mock };
    clientDocument: { count: jest.Mock; upsert: jest.Mock; findUnique: jest.Mock };
  };
  let identityVerificationService: { lookupBvn: jest.Mock; lookupNin: jest.Mock };
  let faceMatchService: { verify: jest.Mock };
  let fileStorageProvider: { putObject: jest.Mock; getObject: jest.Mock; getSignedDownloadUrl: jest.Mock };

  beforeEach(() => {
    prisma = {
      clientOnboarding: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      ippisRecord: { findFirst: jest.fn() },
      client: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'client-1', phone: '+2348000000000' }),
        findUnique: jest.fn().mockResolvedValue({ assignedAgentId: null, assignedAdminId: null }),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      clientDocument: { count: jest.fn().mockResolvedValue(0), upsert: jest.fn(), findUnique: jest.fn() },
    };
    identityVerificationService = { lookupBvn: jest.fn(), lookupNin: jest.fn() };
    faceMatchService = { verify: jest.fn() };
    fileStorageProvider = {
      putObject: jest.fn().mockResolvedValue(undefined),
      getObject: jest.fn((key: string) => Promise.resolve(Buffer.from(`bytes of ${key}`))),
      getSignedDownloadUrl: jest.fn((key: string) => Promise.resolve(`https://storage.example.com/${key}`)),
    };

    service = new ClientOnboardingService(
      prisma as unknown as PrismaService,
      identityVerificationService as unknown as IdentityVerificationService,
      faceMatchService as unknown as FaceMatchService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('linkIppis', () => {
    it('returns the existing onboarding when one already exists for this client', async () => {
      const existingOnboarding = { id: 'existing', step: 'IDENTITY_SUBMITTED' };
      prisma.clientOnboarding.findUnique.mockResolvedValue(existingOnboarding);

      const result = await service.linkIppis('client-1', 'NPF/1');

      expect(result).toEqual({ ...existingOnboarding, bvnSelfieUrl: null, ninSelfieUrl: null, liveSelfieUrl: null });
      expect(prisma.ippisRecord.findFirst).not.toHaveBeenCalled();
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
        phone: '8000000000',
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
        phone: '8000000000',
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

  describe('adminStartOnboarding', () => {
    it('rejects when the IPPIS number is not found', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.adminStartOnboarding('NPF/1', '+2348000000000', 'admin-1')).rejects.toThrow(NotFoundException);
    });

    it('returns the existing onboarding when this IPPIS record is already linked', async () => {
      const existingOnboarding = { id: 'existing', step: 'DOCUMENTS_SUBMITTED' };
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(existingOnboarding);

      const result = await service.adminStartOnboarding('NPF/1', '+2348000000000', 'admin-1');

      expect(result).toEqual({ ...existingOnboarding, bvnSelfieUrl: null, ninSelfieUrl: null, liveSelfieUrl: null });
      expect(prisma.client.upsert).not.toHaveBeenCalled();
    });

    it('rejects with UnprocessableEntityException when the IPPIS record has no phone number on file', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: null });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.adminStartOnboarding('NPF/1', '+2348000000000', 'admin-1')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('resolves the client by the phone on the IPPIS record and creates the onboarding with onboardedById', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        phone: '+2348000000000',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
        maritalStatus: 'Married',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.adminStartOnboarding('NPF/1', '+2348000000000', 'admin-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith({
        where: { phone: '+2348000000000' },
        update: {},
        create: { phone: '+2348000000000', createdById: 'admin-1', assignedAdminId: 'admin-1' },
      });
      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          onboardedById: 'admin-1',
        }),
      });
    });

    it('normalizes a bare, unprefixed IPPIS phone before resolving/creating the client', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        phone: '8038847641',
        employeeName: 'Jane Doe',
        agency: 'NPF',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348038847641' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.adminStartOnboarding('NPF/1', '08038847641', 'admin-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith({
        where: { phone: '+2348038847641' },
        update: {},
        create: { phone: '+2348038847641', createdById: 'admin-1', assignedAdminId: 'admin-1' },
      });
    });
  });

  describe('IPPIS phone tally', () => {
    const record = { id: 'ippis-1', phone: '8038847641', employeeName: 'Jane Doe', agency: 'NPF' };

    it('rejects a self-service link when the client phone is not the IPPIS phone', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.ippisRecord.findFirst.mockResolvedValue(record);

      await expect(service.linkIppis('client-1', 'NPF/1')).rejects.toThrow(UnprocessableEntityException);
      expect(prisma.clientOnboarding.create).not.toHaveBeenCalled();
    });

    it('rejects a phone that does not tally, and creates no client', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.ippisRecord.findFirst.mockResolvedValue(record);

      await expect(service.adminStartOnboarding('NPF/1', '08011111111', 'admin-1')).rejects.toThrow(UnprocessableEntityException);
      expect(prisma.client.upsert).not.toHaveBeenCalled();
    });

    it('checks a resumed onboarding against the onboarded client, not a changed IPPIS phone', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'existing', clientId: 'client-1' });
      prisma.ippisRecord.findFirst.mockResolvedValue(record);

      await expect(service.adminStartOnboarding('NPF/1', '+2348000000000', 'admin-1')).resolves.toBeDefined();
      await expect(service.adminStartOnboarding('NPF/1', '8038847641', 'admin-1')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });

  describe('agentStartOnboarding', () => {
    it('rejects when the IPPIS number is not found', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(NotFoundException);
    });

    it('resumes its own prior attempt when onboardedByAgentId matches this agent', async () => {
      const existingOnboarding = { id: 'existing', step: 'DOCUMENTS_SUBMITTED', onboardedByAgentId: 'agent-1' };
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(existingOnboarding);

      const result = await service.agentStartOnboarding('NPF/1', 'agent-1');

      expect(result).toEqual({ ...existingOnboarding, bvnSelfieUrl: null, ninSelfieUrl: null, liveSelfieUrl: null });
      expect(prisma.client.upsert).not.toHaveBeenCalled();
    });

    it('rejects when the client was already onboarded by a different agent', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'existing', onboardedByAgentId: 'other-agent' });

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client was already self-onboarded', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        id: 'existing',
        onboardedById: null,
        onboardedByAgentId: null,
      });

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('rejects when the client was already admin-onboarded', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '+2348000000000' });
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        id: 'existing',
        onboardedById: 'admin-1',
        onboardedByAgentId: null,
      });

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(ConflictException);
    });

    it('refuses a record whose phone cannot be read, and creates no client', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '803123' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(UnprocessableEntityException);
      expect(prisma.client.upsert).not.toHaveBeenCalled();
    });

    it('creates the client on the +234 form of the phone on the IPPIS record', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: '08038847641' });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.agentStartOnboarding('NPF/1', 'agent-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { phone: '+2348038847641' } }));
    });

    it('rejects with UnprocessableEntityException when the IPPIS record has no phone number on file', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({ id: 'ippis-1', phone: null });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);

      await expect(service.agentStartOnboarding('NPF/1', 'agent-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('resolves the client by phone and creates the onboarding with onboardedByAgentId', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        phone: '+2348000000000',
        employeeName: 'Jane Doe',
        agency: 'NPF',
        bankName: 'GTBank',
        accountNumber: '0123456789',
        employeeStatus: 'ACTIVE',
        legacyId: 'LEGACY-001',
        maritalStatus: 'Married',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348000000000' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.agentStartOnboarding('NPF/1', 'agent-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith({
        where: { phone: '+2348000000000' },
        update: {},
        create: { phone: '+2348000000000' },
      });
      expect(prisma.clientOnboarding.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          clientId: 'client-1',
          ippisRecordId: 'ippis-1',
          onboardedByAgentId: 'agent-1',
        }),
      });
    });

    it('normalizes a bare, unprefixed IPPIS phone before resolving/creating the client', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue({
        id: 'ippis-1',
        phone: '8038847641',
        employeeName: 'Jane Doe',
        agency: 'NPF',
      });
      prisma.clientOnboarding.findUnique.mockResolvedValue(null);
      prisma.client.upsert.mockResolvedValue({ id: 'client-1', phone: '+2348038847641' });
      prisma.clientOnboarding.create.mockResolvedValue({ id: 'onboarding-1' });

      await service.agentStartOnboarding('NPF/1', 'agent-1');

      expect(prisma.client.upsert).toHaveBeenCalledWith({
        where: { phone: '+2348038847641' },
        update: {},
        create: { phone: '+2348038847641' },
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

  describe('submitIdentityVerified', () => {
    it('rejects when the client is not at the IPPIS_LINKED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IDENTITY_SUBMITTED' });
      await expect(
        service.submitIdentityVerified('client-1', '12345678901', '12345678901'),
      ).rejects.toThrow(ConflictException);
    });

    it('throws UnprocessableEntityException and writes nothing when BVN/NIN do not verify', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IPPIS_LINKED' });
      identityVerificationService.lookupBvn.mockResolvedValue({
        firstName: '', lastName: '', dateOfBirth: null, phoneNumber: null, photoBase64: 'YnZuLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });
      identityVerificationService.lookupNin.mockResolvedValue({
        firstName: '', lastName: '', dateOfBirth: null, phoneNumber: null, photoBase64: 'bmluLXBob3Rv',
        gender: null, stateOfOrigin: null, lgaOfOrigin: null, stateOfResidence: null, lgaOfResidence: null,
        maritalStatus: null, address: null, city: null,
      });

      await expect(
        service.submitIdentityVerified('client-1', '12345678901', '98765432109'),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(fileStorageProvider.putObject).not.toHaveBeenCalled();
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
    });

    it('saves and returns the record when BVN/NIN both verify', async () => {
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
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });

      const result = await service.submitIdentityVerified('client-1', '12345678901', '98765432109');

      expect(result).toEqual({
        id: 'onboarding-1',
        step: 'IDENTITY_SUBMITTED',
        bvnSelfieUrl: null,
        ninSelfieUrl: null,
        liveSelfieUrl: null,
      });
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({ identityVerified: true, step: 'IDENTITY_SUBMITTED' }),
      });
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
    const atIdentitySubmitted = {
      step: 'IDENTITY_SUBMITTED',
      identityVerified: true,
      bvnSelfie: 'bvn-key',
      ninSelfie: 'nin-key',
    };
    const passed = { checked: true, minimumScore: 40, scores: { bvn: 0.62, nin: 0.58 }, passed: true, problems: {} };

    it('rejects when the client is not at the IDENTITY_SUBMITTED step', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ step: 'IPPIS_LINKED' });
      await expect(service.submitFaceMatch('client-1', Buffer.from('selfie'))).rejects.toThrow(ConflictException);
    });

    it('completes and sets Client VERIFIED when identity and both face matches pass', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(atIdentitySubmitted);
      faceMatchService.verify.mockResolvedValue(passed);
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(faceMatchService.verify).toHaveBeenCalledWith(Buffer.from('selfie'), expect.any(Function));
      expect(fileStorageProvider.putObject).toHaveBeenCalledWith('client-onboarding/client-1/live-selfie.jpg', Buffer.from('selfie'));
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({
          liveSelfieKey: 'client-onboarding/client-1/live-selfie.jpg',
          faceMatchBvnScore: 0.62,
          faceMatchNinScore: 0.58,
          faceMatchPassed: true,
          faceMatchMinimumScore: 40,
          step: 'COMPLETED',
        }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });

    it('gives the comparison the BVN and NIN photos from storage, empty when one is missing', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(atIdentitySubmitted);
      fileStorageProvider.getObject.mockImplementation((key: string) =>
        key === 'nin-key' ? Promise.reject(new NotFoundException()) : Promise.resolve(Buffer.from(`bytes of ${key}`)),
      );
      faceMatchService.verify.mockResolvedValue(passed);
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      const loadIdPhotos = faceMatchService.verify.mock.calls[0][1] as () => Promise<unknown>;
      await expect(loadIdPhotos()).resolves.toEqual({ bvn: Buffer.from('bytes of bvn-key'), nin: Buffer.alloc(0) });
    });

    it('completes and sets Client VERIFIED when starting from DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ...atIdentitySubmitted, step: 'DOCUMENTS_SUBMITTED' });
      faceMatchService.verify.mockResolvedValue(passed);
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });

    it('routes to MANUAL_REVIEW with the reasons when a face match fails', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(atIdentitySubmitted);
      faceMatchService.verify.mockResolvedValue({
        checked: true,
        minimumScore: 40,
        scores: { bvn: 0.62, nin: 0.21 },
        passed: false,
        problems: { nin: 'BELOW_MINIMUM' },
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({
          faceMatchNinScore: 0.21,
          faceMatchPassed: false,
          step: 'FACE_MATCH_PENDING',
          failureReasons: { identityVerified: true, faceMatchPassed: false, faceMatch: { nin: 'BELOW_MINIMUM' } },
        }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'MANUAL_REVIEW' },
      });
    });

    it('completes on BVN/NIN verification alone when face comparison is switched off', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(atIdentitySubmitted);
      faceMatchService.verify.mockResolvedValue({ checked: false });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(fileStorageProvider.putObject).toHaveBeenCalled();
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({
          faceMatchBvnScore: null,
          faceMatchNinScore: null,
          faceMatchPassed: null,
          faceMatchMinimumScore: null,
          step: 'COMPLETED',
        }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({ where: { id: 'client-1' }, data: { status: 'VERIFIED' } });
    });

    it('still routes to MANUAL_REVIEW when comparison is off but identity was not verified', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ...atIdentitySubmitted, identityVerified: false });
      faceMatchService.verify.mockResolvedValue({ checked: false });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({ where: { id: 'client-1' }, data: { status: 'MANUAL_REVIEW' } });
    });

    it('saves nothing when the photo is unusable, so it can be retaken', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue(atIdentitySubmitted);
      faceMatchService.verify.mockRejectedValue(new UnprocessableEntityException('No face was found in the photo.'));

      await expect(service.submitFaceMatch('client-1', Buffer.from('selfie'))).rejects.toThrow(UnprocessableEntityException);
      expect(fileStorageProvider.putObject).not.toHaveBeenCalled();
      expect(prisma.clientOnboarding.update).not.toHaveBeenCalled();
      expect(prisma.client.update).not.toHaveBeenCalled();
    });

    it('allows re-submission when step is already COMPLETED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ ...atIdentitySubmitted, step: 'COMPLETED' });
      faceMatchService.verify.mockResolvedValue(passed);
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatch('client-1', Buffer.from('selfie'));

      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
      });
    });
  });

  describe('submitFaceMatchFromPassportPhoto', () => {
    it('rejects when the client is not at DOCUMENTS_SUBMITTED', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'IDENTITY_SUBMITTED' });
      await expect(service.submitFaceMatchFromPassportPhoto('client-1')).rejects.toThrow(ConflictException);
    });

    it('rejects when no passport photo has been uploaded', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });
      prisma.clientDocument.findUnique.mockResolvedValue(null);
      await expect(service.submitFaceMatchFromPassportPhoto('client-1')).rejects.toThrow(ConflictException);
    });

    it('rejects with UnprocessableEntityException when the passport photo was uploaded as a PDF', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({ id: 'onboarding-1', step: 'DOCUMENTS_SUBMITTED' });
      prisma.clientDocument.findUnique.mockResolvedValue({
        storageKey: 'client-onboarding/client-1/documents/passport_photo.pdf',
      });
      await expect(service.submitFaceMatchFromPassportPhoto('client-1')).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('compares the stored passport photo with the BVN/NIN photos and completes on a pass', async () => {
      prisma.clientOnboarding.findUnique.mockResolvedValue({
        id: 'onboarding-1',
        step: 'DOCUMENTS_SUBMITTED',
        identityVerified: true,
        bvnSelfie: 'bvn-key',
        ninSelfie: 'nin-key',
      });
      prisma.clientDocument.findUnique.mockResolvedValue({
        storageKey: 'client-onboarding/client-1/documents/passport_photo.jpg',
      });
      faceMatchService.verify.mockResolvedValue({
        checked: true,
        minimumScore: 40,
        scores: { bvn: 0.7, nin: 0.66 },
        passed: true,
        problems: {},
      });
      prisma.clientOnboarding.update.mockResolvedValue({ id: 'onboarding-1', step: 'COMPLETED' });

      await service.submitFaceMatchFromPassportPhoto('client-1');

      expect(faceMatchService.verify).toHaveBeenCalledWith(
        Buffer.from('bytes of client-onboarding/client-1/documents/passport_photo.jpg'),
        expect.any(Function),
      );
      // Already stored as a document; not written again.
      expect(fileStorageProvider.putObject).not.toHaveBeenCalled();
      expect(prisma.clientOnboarding.update).toHaveBeenCalledWith({
        where: { clientId: 'client-1' },
        data: expect.objectContaining({ liveSelfieKey: 'client-onboarding/client-1/documents/passport_photo.jpg' }),
      });
      expect(prisma.client.update).toHaveBeenCalledWith({
        where: { id: 'client-1' },
        data: { status: 'VERIFIED' },
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

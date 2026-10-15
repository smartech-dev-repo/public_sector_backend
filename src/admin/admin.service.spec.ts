import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';

describe('AdminService', () => {
  let service: AdminService;
  let prisma: { adminUser: { findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let fileStorageProvider: { putObject: jest.Mock; deleteObject: jest.Mock; getSignedDownloadUrl: jest.Mock };

  const baseAdmin = {
    id: 'admin-1',
    email: 'admin@example.com',
    firstName: 'Jane',
    lastName: 'Doe',
    fullName: 'Jane Doe',
    isActive: true,
    profileImageKey: null as string | null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    role: { id: 'role-1', name: 'SUPER_ADMIN', description: 'Full access' },
    department: null,
  };

  beforeEach(() => {
    prisma = {
      adminUser: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
    };
    fileStorageProvider = {
      putObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed-url.example/image.jpg'),
    };
    service = new AdminService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  describe('getProfile', () => {
    it('returns resolved role/department with a null profileImageUrl when no image is set', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(baseAdmin);

      const result = await service.getProfile('admin-1');

      expect(result).toEqual({
        id: 'admin-1',
        email: 'admin@example.com',
        firstName: 'Jane',
        lastName: 'Doe',
        fullName: 'Jane Doe',
        isActive: true,
        role: baseAdmin.role,
        department: null,
        profileImageUrl: null,
        createdAt: baseAdmin.createdAt,
        updatedAt: baseAdmin.updatedAt,
      });
      expect(fileStorageProvider.getSignedDownloadUrl).not.toHaveBeenCalled();
    });

    it('resolves a signed URL when a profileImageKey is set', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue({
        ...baseAdmin,
        profileImageKey: 'admin-profile/admin-1/profile-image.jpg',
      });

      const result = await service.getProfile('admin-1');

      expect(fileStorageProvider.getSignedDownloadUrl).toHaveBeenCalledWith(
        'admin-profile/admin-1/profile-image.jpg',
      );
      expect(result.profileImageUrl).toBe('https://signed-url.example/image.jpg');
    });
  });

  describe('updateProfile', () => {
    it('updates only the given field, keeping the other from the current row, and recomputes fullName', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce(baseAdmin)
        .mockResolvedValueOnce({ ...baseAdmin, firstName: 'Janet', fullName: 'Janet Doe' });
      prisma.adminUser.update.mockResolvedValue({});

      await service.updateProfile('admin-1', { firstName: 'Janet' });

      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { firstName: 'Janet', lastName: 'Doe', fullName: 'Janet Doe' },
      });
    });
  });

  describe('uploadProfileImage', () => {
    it('deletes an existing image first, then stores and links the new one', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/old.jpg' })
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/profile-image.jpg' });
      prisma.adminUser.update.mockResolvedValue({});

      const file = { originalname: 'photo.jpg', buffer: Buffer.from('fake-image') } as Express.Multer.File;
      await service.uploadProfileImage('admin-1', file);

      expect(fileStorageProvider.deleteObject).toHaveBeenCalledWith('admin-profile/admin-1/old.jpg');
      expect(fileStorageProvider.putObject).toHaveBeenCalledWith(
        'admin-profile/admin-1/profile-image.jpg',
        file.buffer,
      );
      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { profileImageKey: 'admin-profile/admin-1/profile-image.jpg' },
      });
    });

    it('does not attempt to delete anything when no prior image existed', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: null })
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/profile-image.png' });
      prisma.adminUser.update.mockResolvedValue({});

      const file = { originalname: 'photo.png', buffer: Buffer.from('fake-image') } as Express.Multer.File;
      await service.uploadProfileImage('admin-1', file);

      expect(fileStorageProvider.deleteObject).not.toHaveBeenCalled();
    });
  });

  describe('deleteProfileImage', () => {
    it('clears the key and deletes the stored object when one is set', async () => {
      prisma.adminUser.findUniqueOrThrow
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: 'admin-profile/admin-1/profile-image.jpg' })
        .mockResolvedValueOnce({ ...baseAdmin, profileImageKey: null });
      prisma.adminUser.update.mockResolvedValue({});

      await service.deleteProfileImage('admin-1');

      expect(fileStorageProvider.deleteObject).toHaveBeenCalledWith('admin-profile/admin-1/profile-image.jpg');
      expect(prisma.adminUser.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { profileImageKey: null },
      });
    });

    it('no-ops cleanly when no image was ever set', async () => {
      prisma.adminUser.findUniqueOrThrow.mockResolvedValue(baseAdmin);

      await service.deleteProfileImage('admin-1');

      expect(fileStorageProvider.deleteObject).not.toHaveBeenCalled();
      expect(prisma.adminUser.update).not.toHaveBeenCalled();
    });
  });
});

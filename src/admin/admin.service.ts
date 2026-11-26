import { Inject, Injectable } from '@nestjs/common';
import { extname } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';

export interface UpdateAdminProfileInput {
  firstName?: string;
  lastName?: string;
}

interface AdminWithRelations {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  isActive: boolean;
  profileImageKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: { id: string; name: string; description: string | null };
  department: { id: string; name: string; description: string | null } | null;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async getProfile(adminId: string) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({
      where: { id: adminId },
      include: {
        role: { select: { id: true, name: true, description: true } },
        department: { select: { id: true, name: true, description: true } },
      },
    });
    return this.toProfileResponse(admin);
  }

  async updateProfile(adminId: string, input: UpdateAdminProfileInput) {
    const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    const firstName = input.firstName ?? current.firstName;
    const lastName = input.lastName ?? current.lastName;
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { firstName, lastName, fullName: `${firstName} ${lastName}`.trim() },
    });
    return this.getProfile(adminId);
  }

  async uploadProfileImage(adminId: string, file: Express.Multer.File) {
    const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (current.profileImageKey) {
      await this.fileStorageProvider.deleteObject(current.profileImageKey);
    }
    const storageKey = `admin-profile/${adminId}/profile-image${extname(file.originalname)}`;
    await this.fileStorageProvider.putObject(storageKey, file.buffer);
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { profileImageKey: storageKey } });
    return this.getProfile(adminId);
  }

  async deleteProfileImage(adminId: string) {
    const current = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (current.profileImageKey) {
      await this.fileStorageProvider.deleteObject(current.profileImageKey);
      await this.prisma.adminUser.update({ where: { id: adminId }, data: { profileImageKey: null } });
    }
    return this.getProfile(adminId);
  }

  private async toProfileResponse(admin: AdminWithRelations) {
    const profileImageUrl = admin.profileImageKey
      ? await this.fileStorageProvider.getSignedDownloadUrl(admin.profileImageKey)
      : null;
    return {
      id: admin.id,
      email: admin.email,
      firstName: admin.firstName,
      lastName: admin.lastName,
      fullName: admin.fullName,
      isActive: admin.isActive,
      role: admin.role,
      department: admin.department,
      profileImageUrl,
      createdAt: admin.createdAt,
      updatedAt: admin.updatedAt,
    };
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

@Injectable()
export class AdminRoleAssignmentService {
  constructor(private readonly prisma: PrismaService) {}

  async listAdmins() {
    return this.prisma.adminUser.findMany({
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        createdAt: true,
        roles: { include: { role: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async assignRole(adminId: string, roleId: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    await this.prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: adminId, roleId } },
      update: {},
      create: { adminUserId: adminId, roleId },
    });
  }

  async removeRole(adminId: string, roleId: string): Promise<void> {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });

    if (role?.name === SUPER_ADMIN_ROLE_NAME) {
      const thisAdminHasIt = await this.prisma.adminUserRole.findUnique({
        where: { adminUserId_roleId: { adminUserId: adminId, roleId } },
      });
      if (thisAdminHasIt) {
        const holderCount = await this.prisma.adminUserRole.count({ where: { roleId } });
        if (holderCount <= 1) {
          throw new ConflictException('Cannot remove the last admin holding the SUPER_ADMIN role');
        }
      }
    }

    await this.prisma.adminUserRole.deleteMany({ where: { adminUserId: adminId, roleId } });
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from '../session/session.service';
import { Prisma, SessionPrincipalType } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

export interface ListAdminsFilters {
  isActive?: boolean;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AdminRoleAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessionService: SessionService,
  ) {}

  async listAdmins(
    filters: ListAdminsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.AdminUserWhereInput = {
      isActive: filters.isActive,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { email: { contains: filters.q, mode: 'insensitive' } },
            { fullName: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.adminUser.findMany({
        where,
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          createdAt: true,
          roles: { include: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.adminUser.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
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

  async deactivate(callerId: string, id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (id === callerId) {
      throw new ConflictException('Cannot deactivate your own account');
    }
    if (!admin.isActive) {
      throw new ConflictException('Admin is already deactivated');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: false } });
    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, id, 'admin_deactivated');
  }

  async reactivate(id: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) {
      throw new NotFoundException('Admin not found');
    }
    if (admin.isActive) {
      throw new ConflictException('Admin is already active');
    }

    await this.prisma.adminUser.update({ where: { id }, data: { isActive: true } });
  }
}

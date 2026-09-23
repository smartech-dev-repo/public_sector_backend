import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

export interface CreateRoleParams {
  name: string;
  description?: string;
  departmentId?: string;
}

export interface UpdateRoleParams {
  name?: string;
  description?: string;
  departmentId?: string | null;
}

const ROLE_WITH_PERMISSIONS_INCLUDE = {
  permissions: { include: { permission: true } },
} as const;

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A role named "${params.name}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: { q?: string } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.RoleWhereInput = {
      name: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        include: ROLE_WITH_PERMISSIONS_INCLUDE,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.role.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async findById(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: ROLE_WITH_PERMISSIONS_INCLUDE,
    });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    return role;
  }

  async update(id: string, params: UpdateRoleParams): Promise<Role> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME && params.name && params.name !== role.name) {
      throw new ConflictException('The SUPER_ADMIN role cannot be renamed');
    }
    return this.prisma.role.update({
      where: { id },
      data: { name: params.name, description: params.description, departmentId: params.departmentId },
    });
  }

  async remove(id: string): Promise<void> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME) {
      throw new ConflictException('The SUPER_ADMIN role cannot be deleted');
    }
    const assignmentCount = await this.prisma.adminUserRole.count({ where: { roleId: id } });
    if (assignmentCount > 0) {
      throw new ConflictException('Cannot delete a role that is currently assigned to one or more admins');
    }
    await this.prisma.role.delete({ where: { id } });
  }

  async assignPermission(roleId: string, permissionId: string): Promise<void> {
    await this.findById(roleId);
    const permission = await this.prisma.permission.findUnique({ where: { id: permissionId } });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    await this.prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId, permissionId } },
      update: {},
      create: { roleId, permissionId },
    });
  }

  async removePermission(roleId: string, permissionId: string): Promise<void> {
    await this.prisma.rolePermission.deleteMany({ where: { roleId, permissionId } });
  }
}

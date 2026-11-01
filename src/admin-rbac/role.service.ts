import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';

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

const ROLE_WITH_RELATIONS_INCLUDE = {
  permissions: { include: { permission: true } },
  department: { select: { id: true, name: true } },
  _count: { select: { admins: true } },
} as const;

@Injectable()
export class RoleService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateRoleParams): Promise<Role> {
    try {
      return await this.prisma.role.create({ data: params, include: ROLE_WITH_RELATIONS_INCLUDE });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A role named "${params.name}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: { q?: string; createdFrom?: Date; createdTo?: Date } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.RoleWhereInput = {
      name: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        include: ROLE_WITH_RELATIONS_INCLUDE,
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
      include: ROLE_WITH_RELATIONS_INCLUDE,
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
    try {
      return await this.prisma.role.update({
        where: { id },
        data: { name: params.name, description: params.description, departmentId: params.departmentId },
        include: ROLE_WITH_RELATIONS_INCLUDE,
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A role named "${params.name}" already exists`);
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const role = await this.findById(id);
    if (role.name === SUPER_ADMIN_ROLE_NAME) {
      throw new ConflictException('The SUPER_ADMIN role cannot be deleted');
    }
    const assignmentCount = await this.prisma.adminUser.count({ where: { roleId: id } });
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

  async assignPermissions(roleId: string, permissionIds: string[]): Promise<void> {
    await this.findById(roleId);
    const permissions = await this.prisma.permission.findMany({ where: { id: { in: permissionIds } } });
    const foundIds = new Set(permissions.map((p) => p.id));
    const missing = permissionIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`Permission(s) not found: ${missing.join(', ')}`);
    }

    await this.prisma.$transaction(
      permissionIds.map((permissionId) =>
        this.prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId, permissionId } },
          update: {},
          create: { roleId, permissionId },
        }),
      ),
    );
  }

  listPermissionOptions() {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  /** Makes `permissionIds` the role's exact permission list, returning the keys that changed. */
  async setPermissions(roleId: string, permissionIds: string[]): Promise<{ added: string[]; removed: string[] }> {
    const role = await this.findById(roleId);
    if (role.name === SUPER_ADMIN_ROLE_NAME) {
      throw new ConflictException('The SUPER_ADMIN role always holds every permission and cannot be edited');
    }

    const uniqueIds = [...new Set(permissionIds)];
    const permissions = await this.prisma.permission.findMany({ where: { id: { in: uniqueIds } } });
    const foundIds = new Set(permissions.map((p) => p.id));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundException(`Permission(s) not found: ${missing.join(', ')}`);
    }

    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId, permissionId: { notIn: uniqueIds } } }),
      this.prisma.rolePermission.createMany({
        data: uniqueIds.map((permissionId) => ({ roleId, permissionId })),
        skipDuplicates: true,
      }),
      this.prisma.role.update({ where: { id: roleId }, data: { updatedAt: new Date() } }),
    ]);

    const previous = role.permissions.map((rp) => rp.permission);
    const previousIds = new Set(previous.map((p) => p.id));
    return {
      added: permissions.filter((p) => !previousIds.has(p.id)).map((p) => p.key),
      removed: previous.filter((p) => !foundIds.has(p.id)).map((p) => p.key),
    };
  }

  async removePermission(roleId: string, permissionId: string): Promise<void> {
    const role = await this.findById(roleId);
    if (role.name === SUPER_ADMIN_ROLE_NAME) {
      throw new ConflictException('The SUPER_ADMIN role always holds every permission and cannot be edited');
    }
    await this.prisma.rolePermission.deleteMany({ where: { roleId, permissionId } });
  }
}

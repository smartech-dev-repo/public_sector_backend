import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Permission } from '../generated/prisma/client';

export interface CreatePermissionParams {
  key: string;
  description: string;
}

export interface UpdatePermissionParams {
  description: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreatePermissionParams): Promise<Permission> {
    try {
      return await this.prisma.permission.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A permission with key "${params.key}" already exists`);
      }
      throw error;
    }
  }

  async list(): Promise<Permission[]> {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
  }

  async findById(id: string): Promise<Permission> {
    const permission = await this.prisma.permission.findUnique({ where: { id } });
    if (!permission) {
      throw new NotFoundException('Permission not found');
    }
    return permission;
  }

  async update(id: string, params: UpdatePermissionParams): Promise<Permission> {
    await this.findById(id);
    return this.prisma.permission.update({ where: { id }, data: { description: params.description } });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    const usageCount = await this.prisma.rolePermission.count({ where: { permissionId: id } });
    if (usageCount > 0) {
      throw new ConflictException('Cannot delete a permission that is currently assigned to one or more roles');
    }
    await this.prisma.permission.delete({ where: { id } });
  }
}

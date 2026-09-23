import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Department, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';

export interface CreateDepartmentParams {
  name: string;
  description?: string;
}

export interface UpdateDepartmentParams {
  name?: string;
  description?: string;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

@Injectable()
export class DepartmentService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateDepartmentParams): Promise<Department> {
    try {
      return await this.prisma.department.create({ data: params });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A department named "${params.name}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: { q?: string } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<Department>> {
    const { page, limit } = pagination;
    const where: Prisma.DepartmentWhereInput = {
      name: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.department.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.department.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async findById(id: string): Promise<Department> {
    const department = await this.prisma.department.findUnique({ where: { id } });
    if (!department) {
      throw new NotFoundException('Department not found');
    }
    return department;
  }

  async update(id: string, params: UpdateDepartmentParams): Promise<Department> {
    await this.findById(id);
    return this.prisma.department.update({ where: { id }, data: params });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    const roleCount = await this.prisma.role.count({ where: { departmentId: id } });
    if (roleCount > 0) {
      throw new ConflictException('Cannot delete a department that is currently assigned to one or more roles');
    }
    await this.prisma.department.delete({ where: { id } });
  }
}

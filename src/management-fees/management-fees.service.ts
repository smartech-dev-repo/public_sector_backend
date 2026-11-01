import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ManagementChargeType, ManagementFee, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { assertFeeCoversProductAmounts } from './assert-fee-covers-product-amounts.util';

export interface CreateManagementFeeInput {
  name: string;
  type: ManagementChargeType;
  value: number;
  minAmount?: number | null;
  maxAmount?: number | null;
}

export interface UpdateManagementFeeInput extends Partial<CreateManagementFeeInput> {
  isActive?: boolean;
}

export interface ListManagementFeesFilters {
  q?: string;
  isActive?: boolean;
}

function assertValidFee(type: ManagementChargeType, value: number, minAmount: number | null, maxAmount: number | null) {
  if (type === ManagementChargeType.PERCENTAGE && value > 100) {
    throw new BadRequestException('A percentage fee cannot exceed 100');
  }
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    throw new BadRequestException('minAmount cannot be greater than maxAmount');
  }
}

@Injectable()
export class ManagementFeesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateManagementFeeInput): Promise<ManagementFee> {
    assertValidFee(input.type, input.value, input.minAmount ?? null, input.maxAmount ?? null);
    try {
      return await this.prisma.managementFee.create({ data: input });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A management fee named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: ListManagementFeesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<ManagementFee>> {
    const { page, limit } = pagination;
    const where: Prisma.ManagementFeeWhereInput = {
      isActive: filters.isActive,
      name: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.managementFee.findMany({
        where,
        include: { _count: { select: { loanProducts: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.managementFee.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  listActive(): Promise<ManagementFee[]> {
    return this.prisma.managementFee.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  }

  findById(id: string): Promise<ManagementFee> {
    return this.requireFee(id);
  }

  private async requireFee(id: string) {
    const fee = await this.prisma.managementFee.findUnique({
      where: { id },
      include: { _count: { select: { loanProducts: true } } },
    });
    if (!fee) {
      throw new NotFoundException('Management fee not found');
    }
    return fee;
  }

  async update(id: string, input: UpdateManagementFeeInput): Promise<ManagementFee> {
    const existing = await this.requireFee(id);
    const toNumberOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value));
    assertValidFee(
      input.type ?? existing.type,
      input.value ?? Number(existing.value),
      input.minAmount !== undefined ? input.minAmount : toNumberOrNull(existing.minAmount),
      input.maxAmount !== undefined ? input.maxAmount : toNumberOrNull(existing.maxAmount),
    );

    const merged = {
      minAmount: input.minAmount !== undefined ? input.minAmount : existing.minAmount,
      maxAmount: input.maxAmount !== undefined ? input.maxAmount : existing.maxAmount,
    };
    const linkedProducts = await this.prisma.loanProduct.findMany({
      where: { managementFeeId: id },
      select: { productName: true, minimumAmount: true, maximumAmount: true },
    });
    linkedProducts.forEach((product) => assertFeeCoversProductAmounts({ name: existing.name, ...merged }, product));

    try {
      // Products carry a copy of the charge for new loan requests. Loans already
      // applied for keep the snapshot taken at the time, so they are untouched.
      const [fee] = await this.prisma.$transaction([
        this.prisma.managementFee.update({ where: { id }, data: input }),
        this.prisma.loanProduct.updateMany({
          where: { managementFeeId: id },
          data: { managementChargeType: input.type ?? existing.type, managementChargeValue: input.value ?? existing.value },
        }),
      ]);
      return fee;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A management fee named "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const existing = await this.requireFee(id);
    if (existing._count.loanProducts > 0) {
      throw new ConflictException('This fee is used by a loan product. Deactivate it, or remove it from the product first');
    }
    await this.prisma.managementFee.delete({ where: { id } });
  }
}

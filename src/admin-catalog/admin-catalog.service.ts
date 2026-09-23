import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';

export interface ListLoansFilters {
  agency?: string;
  product?: string;
  q?: string;
  disbursedFrom?: Date;
  disbursedTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
}

export interface ListIppisRecordsFilters {
  agency?: string;
  employeeStatus?: string;
  department?: string;
  grade?: string;
  q?: string;
  hireDateFrom?: Date;
  hireDateTo?: Date;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class AdminCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listLoans(
    filters: ListLoansFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.LoanWhereInput = {
      agency: filters.agency,
      product: filters.product,
      disbursementDate:
        filters.disbursedFrom || filters.disbursedTo
          ? { gte: filters.disbursedFrom, lte: filters.disbursedTo }
          : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { customerName: { contains: filters.q, mode: 'insensitive' } },
            { accountNumber: { contains: filters.q, mode: 'insensitive' } },
            { ippisNumber: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.loan.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.loan.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async listIppisRecords(
    filters: ListIppisRecordsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.IppisRecordWhereInput = {
      agency: filters.agency,
      employeeStatus: filters.employeeStatus,
      department: filters.department,
      grade: filters.grade,
      hireDate:
        filters.hireDateFrom || filters.hireDateTo
          ? { gte: filters.hireDateFrom, lte: filters.hireDateTo }
          : undefined,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      OR: filters.q
        ? [
            { employeeName: { contains: filters.q, mode: 'insensitive' } },
            { staffId: { contains: filters.q, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.ippisRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.ippisRecord.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanTermOption, ManagementChargeApplication, ManagementChargeType, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';

export interface ListLoanTermsFilters {
  agency?: string;
  isActive?: boolean;
}

export interface CreateLoanTermOptionInput {
  agency: string;
  tenorMonths: number;
  interestRatePercent: number;
  managementChargeType: ManagementChargeType;
  managementChargeValue: number;
  managementChargeApplication: ManagementChargeApplication;
}

export interface UpdateLoanTermOptionInput {
  interestRatePercent?: number;
  managementChargeType?: ManagementChargeType;
  managementChargeValue?: number;
  managementChargeApplication?: ManagementChargeApplication;
  isActive?: boolean;
}

@Injectable()
export class LoanTermOptionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateLoanTermOptionInput): Promise<LoanTermOption> {
    return this.prisma.loanTermOption.create({ data: input });
  }

  async list(
    filters: ListLoanTermsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<LoanTermOption>> {
    const { page, limit } = pagination;
    const where: Prisma.LoanTermOptionWhereInput = {
      agency: filters.agency,
      isActive: filters.isActive,
    };

    const [data, total] = await Promise.all([
      this.prisma.loanTermOption.findMany({ where, skip: (page - 1) * limit, take: limit }),
      this.prisma.loanTermOption.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async update(id: string, input: UpdateLoanTermOptionInput): Promise<LoanTermOption> {
    const existing = await this.prisma.loanTermOption.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Loan term option not found');
    }
    return this.prisma.loanTermOption.update({ where: { id }, data: input });
  }

  async listActiveForClient(clientId: string): Promise<LoanTermOption[]> {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return [];
    }
    return this.prisma.loanTermOption.findMany({
      where: { agency: onboarding.ippisRecord.agency, isActive: true },
    });
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanTermOption, ManagementChargeApplication, ManagementChargeType } from '../generated/prisma/client';

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

  async list(agency?: string): Promise<LoanTermOption[]> {
    return this.prisma.loanTermOption.findMany({ where: { agency } });
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

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettings } from '../generated/prisma/client';

export interface UpdateLoanSettingsInput {
  retirementAgeYears?: number;
  maxServiceYears?: number;
}

@Injectable()
export class LoanSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<LoanSettings> {
    const existing = await this.prisma.loanSettings.findFirst();
    if (existing) return existing;
    return this.prisma.loanSettings.create({ data: {} });
  }

  async update(input: UpdateLoanSettingsInput): Promise<LoanSettings> {
    const current = await this.get();
    return this.prisma.loanSettings.update({ where: { id: current.id }, data: input });
  }
}

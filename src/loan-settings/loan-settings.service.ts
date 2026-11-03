import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanSettings, Prisma } from '../generated/prisma/client';
import {
  allowedOutcomes,
  DEFAULT_SALARY_PATTERN_OUTCOMES,
  resolveOutcomes,
  SALARY_PATTERN_ALIASES,
  SALARY_PATTERNS,
  SalaryPattern,
  SalaryOutcome,
} from '../loan-request/eligibility/affordability/salary-pattern.util';
import { capacityChange } from './repayment-capacity.util';
import { RepaymentCapacityDto } from './dto/repayment-capacity.dto';

export interface UpdateLoanSettingsInput extends RepaymentCapacityDto {
  retirementAgeYears?: number;
  maxServiceYears?: number;
  loanApprovalPhone?: string;
  salaryPatternOutcomes?: Record<string, string>;
}

@Injectable()
export class LoanSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<LoanSettings> {
    const existing = await this.prisma.loanSettings.findFirst();
    if (existing) return existing;
    return this.prisma.loanSettings.create({ data: {} });
  }

  /** Settings plus the salary pattern table the back office edits. */
  async getWithSalaryPatterns() {
    const settings = await this.get();
    const outcomes = resolveOutcomes(settings.salaryPatternOutcomes);
    return {
      ...settings,
      salaryPatternOutcomes: outcomes,
      salaryPatterns: SALARY_PATTERNS.map((pattern) => ({
        pattern,
        aliases: SALARY_PATTERN_ALIASES[pattern],
        outcome: outcomes[pattern],
        defaultOutcome: DEFAULT_SALARY_PATTERN_OUTCOMES[pattern],
        allowedOutcomes: allowedOutcomes(pattern),
      })),
    };
  }

  async update(input: UpdateLoanSettingsInput): Promise<LoanSettings> {
    const current = await this.get();
    const { salaryPatternOutcomes, affordabilityMethod, basePayAmount, dtiPercent, ...rest } = input;
    const data: Prisma.LoanSettingsUpdateInput = {
      ...rest,
      ...capacityChange({ affordabilityMethod, basePayAmount, dtiPercent }, current),
    };
    if (salaryPatternOutcomes) {
      data.salaryPatternOutcomes = this.mergeOutcomes(current.salaryPatternOutcomes, salaryPatternOutcomes);
    }
    return this.prisma.loanSettings.update({ where: { id: current.id }, data });
  }

  private mergeOutcomes(stored: unknown, change: Record<string, string>): Record<SalaryPattern, SalaryOutcome> {
    const merged = resolveOutcomes(stored);
    const errors: string[] = [];
    for (const [pattern, outcome] of Object.entries(change)) {
      if (!SALARY_PATTERNS.includes(pattern as SalaryPattern)) {
        errors.push(`${pattern} is not a salary pattern`);
      } else if (!allowedOutcomes(pattern as SalaryPattern).includes(outcome as SalaryOutcome)) {
        errors.push(`${pattern} can be ${allowedOutcomes(pattern as SalaryPattern).join(', ')}, not ${outcome}`);
      } else {
        merged[pattern as SalaryPattern] = outcome as SalaryOutcome;
      }
    }
    if (errors.length) throw new BadRequestException(errors);
    return merged;
  }
}

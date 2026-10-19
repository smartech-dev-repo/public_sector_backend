import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoanProduct, ManagementChargeApplication, ManagementChargeType, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { LoanSettingsService } from '../loan-settings/loan-settings.service';
import { computeServiceWindow } from '../loan-request/eligibility/compute-service-window.util';
import { isServiceLengthEligible } from '../loan-request/eligibility/service-length-eligible.util';
import { hasLifetimeLoan } from '../loan-request/eligibility/has-lifetime-loan.util';
import { EligibilityService } from '../loan-request/eligibility/eligibility.service';
import { TopupEligibilityService } from '../loan-request/eligibility/topup-eligibility.service';
import { ClientLoansService } from '../client-loans/client-loans.service';
import { validateInterestTiers } from './validate-interest-tiers.util';
import { InterestTier } from './interest-tier.interface';

export interface ListLoanProductsFilters {
  sectors?: string;
  isActive?: boolean;
}

export interface CreateLoanProductInput {
  productName: string;
  productCode: string;
  sectors: string[];
  minimumAmount: number;
  maximumAmount: number;
  minimumTenorMonths: number;
  maximumTenorMonths: number;
  interestTiers: InterestTier[];
  managementChargeType: ManagementChargeType;
  managementChargeValue: number;
  managementChargeApplication: ManagementChargeApplication;
  minimumServiceMonthsLeft?: number;
  maximumMonthsInService?: number;
}

export interface UpdateLoanProductInput {
  productName?: string;
  sectors?: string[];
  minimumAmount?: number;
  maximumAmount?: number;
  minimumTenorMonths?: number;
  maximumTenorMonths?: number;
  interestTiers?: InterestTier[];
  managementChargeType?: ManagementChargeType;
  managementChargeValue?: number;
  managementChargeApplication?: ManagementChargeApplication;
  minimumServiceMonthsLeft?: number;
  maximumMonthsInService?: number;
  isActive?: boolean;
}

@Injectable()
export class LoanProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
    private readonly eligibilityService: EligibilityService,
    private readonly topupEligibilityService: TopupEligibilityService,
    private readonly clientLoansService: ClientLoansService,
  ) {}

  async create(input: CreateLoanProductInput): Promise<LoanProduct> {
    validateInterestTiers(input.interestTiers, input.minimumTenorMonths, input.maximumTenorMonths);
    try {
      return await this.prisma.loanProduct.create({
        data: { ...input, interestTiers: input.interestTiers as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(`A loan product with code "${input.productCode}" already exists`);
      }
      throw error;
    }
  }

  async list(
    filters: ListLoanProductsFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<LoanProduct>> {
    const { page, limit } = pagination;
    const where: Prisma.LoanProductWhereInput = {
      sectors: filters.sectors ? { has: filters.sectors } : undefined,
      isActive: filters.isActive,
    };

    const [data, total] = await Promise.all([
      this.prisma.loanProduct.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.loanProduct.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
  }

  async update(id: string, input: UpdateLoanProductInput): Promise<LoanProduct> {
    const existing = await this.prisma.loanProduct.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Loan product not found');
    }

    if (input.interestTiers || input.minimumTenorMonths !== undefined || input.maximumTenorMonths !== undefined) {
      const tiers = input.interestTiers ?? (existing.interestTiers as unknown as InterestTier[]);
      const minimumTenorMonths = input.minimumTenorMonths ?? existing.minimumTenorMonths;
      const maximumTenorMonths = input.maximumTenorMonths ?? existing.maximumTenorMonths;
      validateInterestTiers(tiers, minimumTenorMonths, maximumTenorMonths);
    }

    return this.prisma.loanProduct.update({
      where: { id },
      data: {
        ...input,
        interestTiers: input.interestTiers ? (input.interestTiers as unknown as Prisma.InputJsonValue) : undefined,
      },
    });
  }

  async listEligibleForClient(
    clientId: string,
    filters: { amount?: number } = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<{ mode: 'NEW_LOAN' | 'TOPUP'; eligible: boolean; reason?: string; data: LoanProduct[]; meta: PaginatedResult<LoanProduct>['meta'] }> {
    const { page, limit } = pagination;
    const emptyMeta = buildPaginatedResult<LoanProduct>([], 0, page, limit).meta;

    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding) {
      return { mode: 'NEW_LOAN', eligible: false, reason: 'Client has not completed onboarding', data: [], meta: emptyMeta };
    }

    const client = await this.prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    const mode: 'NEW_LOAN' | 'TOPUP' = (await hasLifetimeLoan(this.prisma, this.clientLoansService, clientId))
      ? 'TOPUP'
      : 'NEW_LOAN';

    const eligibility =
      mode === 'TOPUP'
        ? await this.topupEligibilityService.check(client, onboarding.ippisRecord, 0)
        : await this.eligibilityService.check(client, onboarding.ippisRecord, 0);

    if (!eligibility.eligible) {
      return { mode, eligible: false, reason: eligibility.reason, data: [], meta: emptyMeta };
    }

    const settings = await this.loanSettingsService.get();
    const { monthsLeft, monthsServed } = computeServiceWindow(
      onboarding.ippisRecord.dateOfBirth,
      onboarding.ippisRecord.hireDate,
      settings.retirementAgeYears,
      settings.maxServiceYears,
    );

    const candidates = await this.prisma.loanProduct.findMany({
      where: {
        isActive: true,
        sectors: { has: onboarding.ippisRecord.agency },
        ...(filters.amount !== undefined
          ? { minimumAmount: { lte: filters.amount }, maximumAmount: { gte: filters.amount } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const eligibleProducts = candidates.filter((p) => isServiceLengthEligible(p, monthsLeft, monthsServed));

    const total = eligibleProducts.length;
    const data = eligibleProducts.slice((page - 1) * limit, (page - 1) * limit + limit);

    return { mode, eligible: true, data, meta: buildPaginatedResult(data, total, page, limit).meta };
  }
}

import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LoanSettingsService } from '../../../loan-settings/loan-settings.service';
import { ClientLoansService } from '../../../client-loans/client-loans.service';
import { computeExpectedInstallment } from '../../../reconciliation/amortization.util';
import {
  IppisRecord,
  ManagementChargeApplication,
} from '../../../generated/prisma/client';
import {
  LoanProductMatch,
  LoanProductResolverService,
} from '../loan-product-resolver.service';
import { pickSalary, resolveOutcomes, SalaryPick } from './salary-pattern.util';
import {
  computeMaxLoan,
  RepaymentCapacityPolicy,
  usablePayDetail,
  UsablePayLimit,
} from './max-loan.util';

export type AffordabilityType = 'LOAN' | 'TOPUP';

/** The loan a top-up renews. */
export interface CurrentLoan {
  source: 'APP' | 'INGESTED';
  id: string;
  outstandingBalance: number;
  monthlyRepayment: number;
}

export interface AffordabilityAssessment {
  type: AffordabilityType;
  tenorMonths: number;
  eligible: boolean;
  /** Loan: the most they can borrow. Top-up: the most extra cash. */
  maxAmount: number;
  reason?: string;
  salary: {
    paymentThreeMonthsAgo: number | null;
    paymentTwoMonthsAgo: number | null;
    paymentLastMonth: number | null;
    pattern: SalaryPick['pattern'] | null;
    outcome: SalaryPick['outcome'] | null;
    salaryUsed: number | null;
  };
  /** Top-up: our current repayment, added back because the IPPIS pay is net of it. */
  repaymentAddedBack: number;
  /** limitedBy: for BASE_PAY_DTI, whether the DTI share or keeping base pay set the amount. */
  capacity: (RepaymentCapacityPolicy & { usablePay: number; limitedBy: UsablePayLimit }) | null;
  product: {
    id: string;
    name: string;
    code: string;
    monthlyRatePercent: number;
    minimumAmount: number;
    maximumAmount: number;
    managementChargeType: string;
    managementChargeValue: number;
    managementChargeApplication: string;
  } | null;
  paybackRatio: number | null;
  currentLoan: CurrentLoan | null;
  newLoanTotal: number | null;
  monthlyRepayment: number | null;
  assessedAt: string;
}

const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const formatNaira = (amount: number) => `₦${amount.toLocaleString('en-NG')}`;

/** The message a client sees when they ask for more than their salary allows. */
export function overMaximumMessage(
  assessment: AffordabilityAssessment,
): string {
  const what = assessment.type === 'TOPUP' ? 'top up' : 'borrow';
  return `For ${assessment.tenorMonths} months, the most you can ${what} is ${formatNaira(assessment.maxAmount)}`;
}

/**
 * Works out the most a client can borrow (or top up) over a tenor, from their last three
 * salary payments, their repayment capacity setting and the product's rate for that tenor.
 */
@Injectable()
export class AffordabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loanSettingsService: LoanSettingsService,
    private readonly clientLoansService: ClientLoansService,
    private readonly loanProductResolverService: LoanProductResolverService,
  ) {}

  /** The client's own setting, then their sector's, then the default. Null when none is set. */
  async resolvePolicy(
    clientId: string,
    agency: string,
  ): Promise<RepaymentCapacityPolicy | null> {
    const [client, sector, settings] = await Promise.all([
      this.prisma.client.findUnique({
        where: { id: clientId },
        select: {
          affordabilityMethod: true,
          basePayAmount: true,
          dtiPercent: true,
        },
      }),
      this.prisma.sector.findUnique({
        where: { code: agency },
        select: {
          affordabilityMethod: true,
          basePayAmount: true,
          dtiPercent: true,
        },
      }),
      this.loanSettingsService.get(),
    ]);
    const levels: [RepaymentCapacityPolicy['source'], typeof client][] = [
      ['CLIENT', client],
      ['SECTOR', sector],
      ['DEFAULT', settings],
    ];
    for (const [source, level] of levels) {
      if (!level?.affordabilityMethod) continue;
      const basePayAmount = num(level.basePayAmount);
      const dtiPercent = num(level.dtiPercent);
      const usable =
        level.affordabilityMethod === 'BASE_PAY'
          ? basePayAmount !== null
          : level.affordabilityMethod === 'DTI'
            ? dtiPercent !== null
            : basePayAmount !== null && dtiPercent !== null;
      if (usable)
        return {
          method: level.affordabilityMethod,
          basePayAmount,
          dtiPercent,
          source,
        };
    }
    return null;
  }

  /** The loan a top-up would renew: the latest app loan, else the latest open imported one. */
  async currentLoan(clientId: string): Promise<CurrentLoan | null> {
    const appLoan = await this.prisma.clientLoan.findFirst({
      where: { clientId },
      orderBy: { disbursementDate: 'desc' },
    });
    if (appLoan) {
      const charge =
        appLoan.managementChargeApplication ===
        ManagementChargeApplication.ADD_TO_REPAYMENT
          ? Number(appLoan.managementChargeAmount)
          : 0;
      const balance = Number(appLoan.principalBalance);
      return {
        source: 'APP',
        id: appLoan.id,
        outstandingBalance: Math.max(0, balance),
        monthlyRepayment:
          balance > 0
            ? computeExpectedInstallment(
                Number(appLoan.principalAmount),
                Number(appLoan.interestRatePercent),
                appLoan.disbursementDate,
                appLoan.maturationDate,
                charge,
              )
            : 0,
      };
    }

    const imported =
      await this.clientLoansService.getLatestMatchedLoan(clientId);
    if (!imported) return null;
    const open = imported.status !== 'CLOSED';
    return {
      source: 'INGESTED',
      id: imported.id,
      outstandingBalance: open
        ? Math.max(0, Number(imported.principalBalance))
        : 0,
      monthlyRepayment: open
        ? computeExpectedInstallment(
            Number(imported.loanAmount),
            Number(imported.interestRatePercent),
            imported.disbursementDate,
            imported.maturationDate,
          )
        : 0,
    };
  }

  /**
   * The assessment for a tenor. With `forProduct`, only that product is considered (the one a
   * specific amount resolved to); otherwise the product giving the largest amount is used.
   */
  async assess(
    clientId: string,
    ippisRecord: IppisRecord,
    tenorMonths: number,
    type: AffordabilityType,
    forProduct?: LoanProductMatch,
  ): Promise<AffordabilityAssessment> {
    const [settings, policy, current] = await Promise.all([
      this.loanSettingsService.get(),
      this.resolvePolicy(clientId, ippisRecord.agency),
      type === 'TOPUP' ? this.currentLoan(clientId) : Promise.resolve(null),
    ]);

    const payments: [number | null, number | null, number | null] = [
      num(ippisRecord.paymentThreeMonthsAgo),
      num(ippisRecord.paymentTwoMonthsAgo),
      num(ippisRecord.paymentLastMonth),
    ];
    const pick = pickSalary(
      payments,
      resolveOutcomes(settings.salaryPatternOutcomes),
    );
    const repaymentAddedBack =
      current && current.outstandingBalance > 0 ? current.monthlyRepayment : 0;

    const result: AffordabilityAssessment = {
      type,
      tenorMonths,
      eligible: false,
      maxAmount: 0,
      salary: {
        paymentThreeMonthsAgo: payments[0],
        paymentTwoMonthsAgo: payments[1],
        paymentLastMonth: payments[2],
        pattern: pick?.pattern ?? null,
        outcome: pick?.outcome ?? null,
        salaryUsed: pick?.salary ?? null,
      },
      repaymentAddedBack,
      capacity: null,
      product: null,
      paybackRatio: null,
      currentLoan: current,
      newLoanTotal: null,
      monthlyRepayment: null,
      assessedAt: new Date().toISOString(),
    };

    if (!pick)
      return {
        ...result,
        reason:
          'Salary history incomplete: the last three monthly payments are needed',
      };
    if (!policy) {
      return {
        ...result,
        reason:
          'Repayment capacity is not set up for this client or their sector. Contact an admin.',
      };
    }

    const { usablePay: usable, limitedBy } = usablePayDetail(pick.salary + repaymentAddedBack, policy);
    result.capacity = { ...policy, usablePay: usable, limitedBy };

    const matches = forProduct
      ? [forProduct]
      : await this.loanProductResolverService.candidatesForTenor(
          ippisRecord,
          tenorMonths,
        );
    if (matches.length === 0)
      return {
        ...result,
        reason: `No loan product offers ${tenorMonths} months for this client`,
      };

    const outstanding = current?.outstandingBalance ?? 0;
    const options = matches.map((match) => ({
      match,
      max: computeMaxLoan({
        usablePay: usable,
        tenorMonths,
        monthlyRatePercent: Number(match.tier.interestRatePercent),
        charge: {
          type: match.product.managementChargeType,
          value: Number(match.product.managementChargeValue),
          application: match.product.managementChargeApplication,
        },
        outstandingBalance: outstanding,
        productMinimum: Number(match.product.minimumAmount),
        productMaximum: Number(match.product.maximumAmount),
      }),
    }));
    const best = options.reduce((a, b) =>
      b.max.maxAmount > a.max.maxAmount ? b : a,
    );
    const { product, tier } = best.match;

    return {
      ...result,
      eligible: best.max.maxAmount > 0,
      maxAmount: best.max.maxAmount,
      reason: best.max.reason,
      product: {
        id: product.id,
        name: product.productName,
        code: product.productCode,
        monthlyRatePercent: Number(tier.interestRatePercent),
        minimumAmount: Number(product.minimumAmount),
        maximumAmount: Number(product.maximumAmount),
        managementChargeType: product.managementChargeType,
        managementChargeValue: Number(product.managementChargeValue),
        managementChargeApplication: product.managementChargeApplication,
      },
      paybackRatio: best.max.paybackRatio,
      newLoanTotal: best.max.newLoanTotal,
      monthlyRepayment: best.max.monthlyRepayment,
    };
  }

  /**
   * What the client, their agent or an admin sees before asking: the most available for the
   * tenor, with the workings. Without a type it is a top-up when the client already has a loan.
   */
  async preview(
    clientId: string,
    tenorMonths: number,
    type?: AffordabilityType,
  ) {
    const onboarding = await this.prisma.clientOnboarding.findUnique({
      where: { clientId },
      include: { ippisRecord: true },
    });
    if (!onboarding)
      throw new ConflictException('Client has not completed onboarding');

    const resolvedType =
      type ?? ((await this.currentLoan(clientId)) ? 'TOPUP' : 'LOAN');
    const [assessment, tenorRange] = await Promise.all([
      this.assess(clientId, onboarding.ippisRecord, tenorMonths, resolvedType),
      this.prisma.loanProduct.aggregate({
        where: {
          isActive: true,
          sectors: { has: onboarding.ippisRecord.agency },
        },
        _min: { minimumTenorMonths: true },
        _max: { maximumTenorMonths: true },
      }),
    ]);
    return {
      ...assessment,
      tenorRange: {
        min: tenorRange._min.minimumTenorMonths,
        max: tenorRange._max.maximumTenorMonths,
      },
    };
  }
}

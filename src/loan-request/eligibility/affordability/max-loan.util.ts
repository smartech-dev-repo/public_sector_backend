import { paybackRatio } from '../../../reconciliation/amortization.util';

export type RepaymentCapacityMethod = 'BASE_PAY' | 'DTI' | 'BASE_PAY_DTI';

export interface RepaymentCapacityPolicy {
  method: RepaymentCapacityMethod;
  /** BASE_PAY: the naira amount the client must keep each month. */
  basePayAmount: number | null;
  /** DTI: the share of salary that can go to repayment, e.g. 33.33. */
  dtiPercent: number | null;
  /** Where the policy came from: the client's own setting, their sector's, or the default. */
  source: 'CLIENT' | 'SECTOR' | 'DEFAULT';
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Which limit set the usable pay: the DTI share, or what is left above base pay. */
export type UsablePayLimit = 'BASE_PAY' | 'DTI';

/**
 * The most the client can repay each month, never negative, and which limit set it.
 *
 *   BASE_PAY      salary − base pay
 *   DTI           salary × DTI %
 *   BASE_PAY_DTI  the lower of the two: the DTI share, cut back so the client
 *                 still keeps their base pay
 */
export function usablePayDetail(
  salary: number,
  policy: RepaymentCapacityPolicy,
): { usablePay: number; limitedBy: UsablePayLimit } {
  const aboveBasePay = salary - (policy.basePayAmount ?? 0);
  const dtiShare = (salary * (policy.dtiPercent ?? 0)) / 100;
  if (policy.method === 'BASE_PAY')
    return {
      usablePay: Math.max(0, round2(aboveBasePay)),
      limitedBy: 'BASE_PAY',
    };
  if (policy.method === 'DTI')
    return { usablePay: Math.max(0, round2(dtiShare)), limitedBy: 'DTI' };
  return aboveBasePay < dtiShare
    ? { usablePay: Math.max(0, round2(aboveBasePay)), limitedBy: 'BASE_PAY' }
    : { usablePay: Math.max(0, round2(dtiShare)), limitedBy: 'DTI' };
}

export function usablePay(
  salary: number,
  policy: RepaymentCapacityPolicy,
): number {
  return usablePayDetail(salary, policy).usablePay;
}

export interface MaxLoanInput {
  usablePay: number;
  tenorMonths: number;
  monthlyRatePercent: number;
  charge: {
    type: 'PERCENTAGE' | 'FLAT';
    value: number;
    application: 'DEDUCT_FROM_DISBURSEMENT' | 'ADD_TO_REPAYMENT';
  };
  /** Top-up only: what the client still owes on the loan being renewed. */
  outstandingBalance?: number;
  productMinimum: number;
  productMaximum: number;
  /** The amount is rounded down to a multiple of this. */
  roundTo?: number;
}

export interface MaxLoanResult {
  paybackRatio: number;
  /** For a loan, the most they can borrow. For a top-up, the most extra cash on top of the balance. */
  maxAmount: number;
  /** The loan's size after this amount: the amount itself, or balance + top-up. */
  newLoanTotal: number;
  /** The repayment at the maximum, which stays within usable pay. */
  monthlyRepayment: number;
  /** Set when maxAmount is 0. */
  reason?: string;
}

/**
 * Amount = Usable pay × Tenor / Payback ratio, where Payback ratio = 1 + rate × tenor / 100.
 *
 * A top-up renews the loan: the outstanding balance is repaid over the new tenor at the
 * new rate too, so it takes its share of the usable pay first, and the extra cash is
 * (usable pay × tenor − balance × ratio) / ratio = the loan maximum − balance.
 *
 * A charge added to repayment also comes out of the usable pay: a flat one directly,
 * a percentage one by raising the ratio for the new cash. A charge taken off the
 * disbursement doesn't change what the client repays, so it doesn't change the maximum.
 */
export function computeMaxLoan(input: MaxLoanInput): MaxLoanResult {
  const {
    tenorMonths,
    monthlyRatePercent,
    charge,
    productMinimum,
    productMaximum,
  } = input;
  const outstanding = Math.max(0, input.outstandingBalance ?? 0);
  const roundTo = input.roundTo ?? 1000;
  const ratio = paybackRatio(monthlyRatePercent, tenorMonths);

  const added = charge.application === 'ADD_TO_REPAYMENT';
  const fixedChargePerMonth =
    added && charge.type === 'FLAT' ? charge.value / tenorMonths : 0;
  const cashRatio =
    ratio + (added && charge.type === 'PERCENTAGE' ? charge.value / 100 : 0);
  const usableForLoan = input.usablePay - fixedChargePerMonth;

  const raw = (usableForLoan * tenorMonths - outstanding * ratio) / cashRatio;
  const capped = Math.min(raw, productMaximum - outstanding);
  const maxAmount = Math.max(0, Math.floor(capped / roundTo) * roundTo);

  const repaymentAt = (amount: number) => {
    const chargeAmount = added
      ? charge.type === 'PERCENTAGE'
        ? (amount * charge.value) / 100
        : charge.value
      : 0;
    return round2(
      ((outstanding + amount) * ratio + chargeAmount) / tenorMonths,
    );
  };

  const fail = (reason: string): MaxLoanResult => ({
    paybackRatio: ratio,
    maxAmount: 0,
    newLoanTotal: outstanding,
    monthlyRepayment: 0,
    reason,
  });

  if (input.usablePay <= 0)
    return fail('Salary leaves nothing for a monthly repayment');
  if (maxAmount <= 0) {
    return fail(
      outstanding > 0
        ? 'The outstanding balance already uses all of the repayment the salary allows'
        : 'Salary is too low for a repayment over this tenor',
    );
  }
  if (outstanding + maxAmount < productMinimum) {
    return fail(
      `The most this salary allows is below the product minimum of ₦${productMinimum.toLocaleString('en-NG')}`,
    );
  }

  return {
    paybackRatio: ratio,
    maxAmount,
    newLoanTotal: outstanding + maxAmount,
    monthlyRepayment: repaymentAt(maxAmount),
  };
}

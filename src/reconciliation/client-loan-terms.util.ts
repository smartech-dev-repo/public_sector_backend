import {
  computeExpectedInstallment,
  monthsBetween,
  paybackRatio,
  principalShareOfPayment,
} from './amortization.util';

interface ClientLoanLike {
  principalAmount: unknown;
  principalBalance: unknown;
  interestRatePercent: unknown;
  managementChargeApplication: string;
  managementChargeAmount: unknown;
  disbursementDate: Date;
  maturationDate: Date;
}

/** The charge the client repays with their installments, when it isn't taken at disbursement. */
export function chargeAddedToRepayment(loan: ClientLoanLike): number {
  return loan.managementChargeApplication === 'ADD_TO_REPAYMENT'
    ? Number(loan.managementChargeAmount)
    : 0;
}

/** The monthly repayment on an app loan: flat monthly interest, plus any charge added to repayment. */
export function clientLoanInstallment(loan: ClientLoanLike): number {
  return computeExpectedInstallment(
    Number(loan.principalAmount),
    Number(loan.interestRatePercent),
    loan.disbursementDate,
    loan.maturationDate,
    chargeAddedToRepayment(loan),
  );
}

function terms(loan: ClientLoanLike) {
  return {
    principalAmount: Number(loan.principalAmount),
    monthlyRatePercent: Number(loan.interestRatePercent),
    tenorMonths: Math.max(
      1,
      monthsBetween(loan.disbursementDate, loan.maturationDate),
    ),
    chargeAddedToRepayment: chargeAddedToRepayment(loan),
  };
}

/** How much a repayment takes off an app loan's principal balance. */
export function clientLoanPrincipalPaid(
  loan: ClientLoanLike,
  payment: number,
): number {
  return principalShareOfPayment(payment, terms(loan));
}

/** What is left to repay in total (principal plus its share of interest and charge). */
export function clientLoanRemainingRepayable(loan: ClientLoanLike): number {
  const t = terms(loan);
  if (t.principalAmount <= 0) return 0;
  const total =
    t.principalAmount * paybackRatio(t.monthlyRatePercent, t.tenorMonths) +
    t.chargeAddedToRepayment;
  return (
    Math.round(
      ((Number(loan.principalBalance) * total) / t.principalAmount) * 100,
    ) / 100
  );
}

export function monthsBetween(start: Date, end: Date): number {
  return (
    (end.getFullYear() - start.getFullYear()) * 12 +
    (end.getMonth() - start.getMonth())
  );
}

/**
 * Payback ratio for a flat monthly rate: 1 + (rate × tenor) / 100.
 * A 5% monthly rate over 6 months gives 1.30, so ₦100,000 borrowed is ₦130,000 repaid.
 */
export function paybackRatio(
  monthlyRatePercent: number,
  tenorMonths: number,
): number {
  return 1 + (monthlyRatePercent * tenorMonths) / 100;
}

/**
 * The monthly repayment on a loan at a flat monthly interest rate: the principal plus
 * rate × tenor of interest (plus any charge added to repayment), spread evenly over the tenor.
 * Loan products and the disbursed-loans broadsheet both record the rate as monthly.
 */
export function computeExpectedInstallment(
  loanAmount: number,
  monthlyRatePercent: number,
  disbursementDate: Date,
  maturationDate: Date,
  chargeAddedToRepayment = 0,
): number {
  const termMonths = monthsBetween(disbursementDate, maturationDate);
  if (termMonths <= 0) {
    return loanAmount;
  }
  const totalRepayable =
    loanAmount * paybackRatio(monthlyRatePercent, termMonths) +
    chargeAddedToRepayment;
  return Math.round((totalRepayable / termMonths) * 100) / 100;
}

/**
 * How much of a repayment comes off the principal. Each payment carries principal and
 * interest in the same proportion as the whole loan, so a full installment clears
 * principal / tenor of the balance.
 */
export function principalShareOfPayment(
  payment: number,
  loan: {
    principalAmount: number;
    monthlyRatePercent: number;
    tenorMonths: number;
    chargeAddedToRepayment?: number;
  },
): number {
  const totalRepayable =
    loan.principalAmount *
      paybackRatio(loan.monthlyRatePercent, loan.tenorMonths) +
    (loan.chargeAddedToRepayment ?? 0);
  if (totalRepayable <= 0) return payment;
  return (
    Math.round(((payment * loan.principalAmount) / totalRepayable) * 100) / 100
  );
}

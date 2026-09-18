function monthsBetween(start: Date, end: Date): number {
  return (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
}

export function computeExpectedInstallment(
  loanAmount: number,
  interestRatePercent: number,
  disbursementDate: Date,
  maturationDate: Date,
): number {
  const termMonths = monthsBetween(disbursementDate, maturationDate);
  if (termMonths <= 0) {
    return loanAmount;
  }

  const monthlyRate = interestRatePercent / 100 / 12;
  if (monthlyRate === 0) {
    return Math.round((loanAmount / termMonths) * 100) / 100;
  }

  const factor = Math.pow(1 + monthlyRate, termMonths);
  return Math.round(((loanAmount * monthlyRate * factor) / (factor - 1)) * 100) / 100;
}

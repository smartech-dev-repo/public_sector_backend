import { RepaymentMatchStatus } from '../generated/prisma/client';
import { toPeriodKey } from './period.util';

export interface MatchableDeduction {
  agency: string;
  staffId: string;
  period: string | null;
}

export interface MatchableClientLoan {
  id: string;
  agency: string;
  staffId: string;
  disbursementDate: Date;
  maturationDate: Date;
}

export interface MatchableLoan {
  id: string;
  agency: string | null;
  ippisNumber: string;
  disbursementDate: Date;
  maturationDate: Date;
  settledAt: Date | null;
}

export interface DeductionMatch {
  status: RepaymentMatchStatus;
  clientLoanId: string | null;
  loanId: string | null;
}

/** The loans and undisbursed requests a deduction can be matched against, looked up by agency and staff ID. */
export class DeductionMatchContext {
  private readonly clientLoans = new Map<string, MatchableClientLoan[]>();
  private readonly loans = new Map<string, MatchableLoan[]>();
  private readonly requested: Set<string>;

  constructor(
    clientLoans: MatchableClientLoan[],
    loans: MatchableLoan[],
    /** `agency::staffId` of every client with a loan request that hasn't become a loan. */
    requested: Iterable<string>,
  ) {
    for (const loan of clientLoans) push(this.clientLoans, staffKey(loan.agency, loan.staffId), loan);
    for (const loan of loans) {
      if (loan.agency) push(this.loans, staffKey(loan.agency, loan.ippisNumber), loan);
    }
    this.requested = new Set(requested);
  }

  match(deduction: MatchableDeduction): DeductionMatch {
    return matchDeduction(
      deduction,
      this.clientLoans.get(staffKey(deduction.agency, deduction.staffId)) ?? [],
      this.loans.get(staffKey(deduction.agency, deduction.staffId)) ?? [],
      this.requested.has(staffKey(deduction.agency, deduction.staffId)),
    );
  }
}

export function staffKey(agency: string, staffId: string): string {
  return `${agency}::${staffId.trim().toUpperCase()}`;
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function isWithinLoanPeriod(
  period: string,
  loan: { disbursementDate: Date; maturationDate: Date; settledAt?: Date | null },
): boolean {
  if (period < toPeriodKey(loan.disbursementDate) || period > toPeriodKey(loan.maturationDate)) return false;
  // Once an app top-up has taken over an imported loan, its deductions belong to the app loan.
  return !loan.settledAt || period < toPeriodKey(loan.settledAt);
}

/**
 * Which loan a deduction belongs to: an app loan running in its month first, then an imported
 * one. Otherwise, why none fits, judged against the client's loans or, failing that, their requests.
 */
export function matchDeduction(
  deduction: MatchableDeduction,
  clientLoans: MatchableClientLoan[],
  loans: MatchableLoan[],
  hasUndisbursedRequest: boolean,
): DeductionMatch {
  const none = (status: RepaymentMatchStatus): DeductionMatch => ({ status, clientLoanId: null, loanId: null });
  const { period } = deduction;
  if (!period) return none(RepaymentMatchStatus.NO_PERIOD);

  const appLoan = clientLoans.find((loan) => isWithinLoanPeriod(period, loan));
  if (appLoan) return { status: RepaymentMatchStatus.MATCHED, clientLoanId: appLoan.id, loanId: null };
  const imported = loans.find((loan) => isWithinLoanPeriod(period, loan));
  if (imported) return { status: RepaymentMatchStatus.MATCHED, clientLoanId: null, loanId: imported.id };

  const all = [...clientLoans, ...loans];
  if (all.length === 0) {
    return none(hasUndisbursedRequest ? RepaymentMatchStatus.REQUEST_NOT_DISBURSED : RepaymentMatchStatus.NO_LOAN);
  }
  const settled = loans.some(
    (loan) => loan.settledAt && period >= toPeriodKey(loan.settledAt) && period <= toPeriodKey(loan.maturationDate),
  );
  if (settled) return none(RepaymentMatchStatus.AFTER_SETTLEMENT);
  if (all.every((loan) => period < toPeriodKey(loan.disbursementDate))) {
    return none(RepaymentMatchStatus.BEFORE_DISBURSEMENT);
  }
  return none(RepaymentMatchStatus.AFTER_MATURITY);
}

/** Said in the upload review and the unmatched list. */
export const MATCH_STATUS_MESSAGES: Record<Exclude<RepaymentMatchStatus, 'MATCHED'>, string> = {
  NO_LOAN: 'No loan for this staff number',
  REQUEST_NOT_DISBURSED: 'This staff member has a loan request, but it has not been disbursed',
  BEFORE_DISBURSEMENT: 'Deduction month is before the loan was disbursed',
  AFTER_MATURITY: 'Deduction month is after the loan ended',
  AFTER_SETTLEMENT: 'Deduction month is after the loan was taken over by a top-up',
  NO_PERIOD: 'Deduction has no month',
};

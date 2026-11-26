import { DeductionMatchContext, matchDeduction } from './deduction-match.util';

const d = (period: string | null) => ({ agency: 'NPF', staffId: 'PF1', period });
const appLoan = { id: 'app-1', agency: 'NPF', staffId: 'PF1', disbursementDate: new Date(2026, 3, 10), maturationDate: new Date(2027, 2, 10) };
const imported = {
  id: 'imp-1', agency: 'NPF', ippisNumber: 'PF1', disbursementDate: new Date(2025, 0, 5), maturationDate: new Date(2026, 0, 5), settledAt: null,
};

describe('matchDeduction', () => {
  it('matches the app loan running in the month first, then an imported one', () => {
    expect(matchDeduction(d('2026-04'), [appLoan], [imported], false)).toEqual({ status: 'MATCHED', clientLoanId: 'app-1', loanId: null });
    expect(matchDeduction(d('2025-06'), [appLoan], [imported], false)).toEqual({ status: 'MATCHED', clientLoanId: null, loanId: 'imp-1' });
  });

  it('says why nothing fits', () => {
    expect(matchDeduction(d('2026-08'), [], [], false).status).toBe('NO_LOAN');
    expect(matchDeduction(d('2026-08'), [], [], true).status).toBe('REQUEST_NOT_DISBURSED');
    expect(matchDeduction(d('2026-03'), [appLoan], [], false).status).toBe('BEFORE_DISBURSEMENT');
    expect(matchDeduction(d('2026-02'), [], [imported], false).status).toBe('AFTER_MATURITY');
    expect(matchDeduction(d(null), [appLoan], [], false).status).toBe('NO_PERIOD');
  });

  it('a month between two loans counts as after the earlier one ended', () => {
    expect(matchDeduction(d('2026-02'), [appLoan], [imported], false).status).toBe('AFTER_MATURITY');
  });

  it('an imported loan taken over by a top-up stops matching from that month', () => {
    const settled = { ...imported, settledAt: new Date(2025, 5, 20) };
    expect(matchDeduction(d('2025-05'), [], [settled], false).status).toBe('MATCHED');
    expect(matchDeduction(d('2025-06'), [], [settled], false).status).toBe('AFTER_SETTLEMENT');
  });
});

describe('DeductionMatchContext', () => {
  it('looks loans up by sector and staff ID, ignoring case and spaces', () => {
    const context = new DeductionMatchContext([appLoan], [], []);
    expect(context.match({ agency: 'NPF', staffId: ' pf1 ', period: '2026-05' }).clientLoanId).toBe('app-1');
    expect(context.match({ agency: 'NSCDC', staffId: 'PF1', period: '2026-05' }).status).toBe('NO_LOAN');
  });
});

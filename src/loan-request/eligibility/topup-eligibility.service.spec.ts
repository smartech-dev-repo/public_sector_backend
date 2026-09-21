import { TopupEligibilityService } from './topup-eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { HasActiveLoanRule } from './has-active-loan.rule';
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('TopupEligibilityService', () => {
  function buildService(overrides: { hasActiveLoan?: boolean; noTopupInProgress?: boolean } = {}) {
    const clientMustBeVerifiedRule = { check: () => ({ eligible: true }) } as unknown as ClientMustBeVerifiedRule;
    const amountWithinSalaryCapRule = { check: () => ({ eligible: true }) } as unknown as AmountWithinSalaryCapRule;
    const hasActiveLoanRule = {
      check: () =>
        overrides.hasActiveLoan === false
          ? { eligible: false, reason: 'Client has no active loan to top up' }
          : { eligible: true },
    } as unknown as HasActiveLoanRule;
    const noTopupInProgressRule = {
      check: () =>
        overrides.noTopupInProgress === false
          ? { eligible: false, reason: 'A previous loan request is still in progress' }
          : { eligible: true },
    } as unknown as NoTopupInProgressRule;
    return new TopupEligibilityService(
      clientMustBeVerifiedRule,
      amountWithinSalaryCapRule,
      hasActiveLoanRule,
      noTopupInProgressRule,
    );
  }

  const client = {} as Client;
  const ippisRecord = {} as IppisRecord;

  it('passes when every rule passes', async () => {
    const service = buildService();
    const result = await service.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(true);
  });

  it('fails when HasActiveLoanRule fails', async () => {
    const service = buildService({ hasActiveLoan: false });
    const result = await service.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no active loan/);
  });

  it('fails when NoTopupInProgressRule fails', async () => {
    const service = buildService({ noTopupInProgress: false });
    const result = await service.check(client, ippisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/still in progress/);
  });
});

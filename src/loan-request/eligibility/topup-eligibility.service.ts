import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { HasActiveLoanRule } from './has-active-loan.rule';
import { NoTopupInProgressRule } from './no-topup-in-progress.rule';

@Injectable()
export class TopupEligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(
    clientMustBeVerifiedRule: ClientMustBeVerifiedRule,
    amountWithinSalaryCapRule: AmountWithinSalaryCapRule,
    hasActiveLoanRule: HasActiveLoanRule,
    noTopupInProgressRule: NoTopupInProgressRule,
  ) {
    this.rules = [clientMustBeVerifiedRule, amountWithinSalaryCapRule, hasActiveLoanRule, noTopupInProgressRule];
  }

  async check(client: Client, ippisRecord: IppisRecord, amount: number): Promise<EligibilityCheckResult> {
    for (const rule of this.rules) {
      const result = await rule.check(client, ippisRecord, amount);
      if (!result.eligible) {
        return result;
      }
    }
    return { eligible: true };
  }
}

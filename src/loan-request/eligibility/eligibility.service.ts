import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';

@Injectable()
export class EligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(
    clientMustBeVerifiedRule: ClientMustBeVerifiedRule,
    amountWithinSalaryCapRule: AmountWithinSalaryCapRule,
  ) {
    this.rules = [clientMustBeVerifiedRule, amountWithinSalaryCapRule];
  }

  check(client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult {
    for (const rule of this.rules) {
      const result = rule.check(client, ippisRecord, amount);
      if (!result.eligible) {
        return result;
      }
    }
    return { eligible: true };
  }
}

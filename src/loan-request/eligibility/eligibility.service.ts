import { Injectable } from '@nestjs/common';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { NoActiveLoanRule } from './no-active-loan.rule';

@Injectable()
export class EligibilityService {
  private readonly rules: EligibilityRule[];

  constructor(clientMustBeVerifiedRule: ClientMustBeVerifiedRule, noActiveLoanRule: NoActiveLoanRule) {
    this.rules = [clientMustBeVerifiedRule, noActiveLoanRule];
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

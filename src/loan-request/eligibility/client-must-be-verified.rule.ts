import { Injectable } from '@nestjs/common';
import { Client, ClientStatus, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class ClientMustBeVerifiedRule implements EligibilityRule {
  check(client: Client, _ippisRecord: IppisRecord, _amount: number): EligibilityCheckResult {
    if (client.status !== ClientStatus.VERIFIED) {
      return { eligible: false, reason: `Client must be VERIFIED (currently ${client.status})` };
    }
    return { eligible: true };
  }
}

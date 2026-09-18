import { Client, IppisRecord } from '../../generated/prisma/client';

export interface EligibilityCheckResult {
  eligible: boolean;
  reason?: string;
}

export interface EligibilityRule {
  check(client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult;
}

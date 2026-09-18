import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, IppisRecord } from '../../generated/prisma/client';
import { EligibilityCheckResult, EligibilityRule } from './eligibility-rule.interface';

@Injectable()
export class AmountWithinSalaryCapRule implements EligibilityRule {
  constructor(private readonly configService: ConfigService) {}

  check(_client: Client, ippisRecord: IppisRecord, amount: number): EligibilityCheckResult {
    const multiple = Number(this.configService.get<string>('LOAN_SALARY_MULTIPLE_CAP', '3'));
    const salary = ippisRecord.salary ? Number(ippisRecord.salary) : 0;
    if (salary <= 0) {
      return { eligible: false, reason: 'No salary on record to determine eligibility' };
    }
    const cap = salary * multiple;
    if (amount > cap) {
      return { eligible: false, reason: `Requested amount exceeds the maximum of ${cap} (${multiple}x salary)` };
    }
    return { eligible: true };
  }
}

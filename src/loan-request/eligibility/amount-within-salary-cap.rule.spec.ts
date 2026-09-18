import { ConfigService } from '@nestjs/config';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('AmountWithinSalaryCapRule', () => {
  function buildRule(capMultiple: string) {
    return new AmountWithinSalaryCapRule({ get: () => capMultiple } as unknown as ConfigService);
  }

  const client = {} as Client;

  it('passes when the amount is within the cap', () => {
    const rule = buildRule('3');
    const result = rule.check(client, { salary: 100000 } as unknown as IppisRecord, 300000);
    expect(result.eligible).toBe(true);
  });

  it('fails when the amount exceeds the cap', () => {
    const rule = buildRule('3');
    const result = rule.check(client, { salary: 100000 } as unknown as IppisRecord, 300001);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });

  it('fails when there is no salary on record', () => {
    const rule = buildRule('3');
    const result = rule.check(client, { salary: null } as unknown as IppisRecord, 1000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/No salary/);
  });
});

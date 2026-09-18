import { ConfigService } from '@nestjs/config';
import { EligibilityService } from './eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('EligibilityService', () => {
  function buildService(capMultiple = '3') {
    const configService = { get: () => capMultiple } as unknown as ConfigService;
    return new EligibilityService(
      new ClientMustBeVerifiedRule(),
      new AmountWithinSalaryCapRule(configService),
    );
  }

  const verifiedClient = { status: 'VERIFIED' } as Client;
  const unverifiedClient = { status: 'PENDING_IPPIS' } as Client;
  const ippisRecordWithSalary = { salary: 100000 } as unknown as IppisRecord;

  it('passes when every rule passes', () => {
    const service = buildService();
    const result = service.check(verifiedClient, ippisRecordWithSalary, 200000);
    expect(result.eligible).toBe(true);
  });

  it('fails fast on the first failing rule without evaluating later rules', () => {
    const service = buildService();
    const result = service.check(unverifiedClient, ippisRecordWithSalary, 999999999);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/VERIFIED/);
  });

  it('fails the salary cap rule when the amount exceeds it', () => {
    const service = buildService();
    const result = service.check(verifiedClient, ippisRecordWithSalary, 400000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });
});

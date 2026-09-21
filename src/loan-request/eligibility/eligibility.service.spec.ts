import { ConfigService } from '@nestjs/config';
import { EligibilityService } from './eligibility.service';
import { ClientMustBeVerifiedRule } from './client-must-be-verified.rule';
import { AmountWithinSalaryCapRule } from './amount-within-salary-cap.rule';
import { NoActiveLoanRule } from './no-active-loan.rule';
import { PrismaService } from '../../prisma/prisma.service';
import { ClientLoansService } from '../../client-loans/client-loans.service';
import { Client, IppisRecord } from '../../generated/prisma/client';

describe('EligibilityService', () => {
  function buildService(capMultiple = '3') {
    const configService = { get: () => capMultiple } as unknown as ConfigService;
    const prisma = {
      loanRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      clientLoan: { findFirst: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const clientLoansService = {
      getDashboard: jest.fn().mockResolvedValue({ loans: [], repayments: [] }),
    } as unknown as ClientLoansService;
    return new EligibilityService(
      new ClientMustBeVerifiedRule(),
      new AmountWithinSalaryCapRule(configService),
      new NoActiveLoanRule(prisma, clientLoansService),
    );
  }

  const verifiedClient = { status: 'VERIFIED' } as Client;
  const unverifiedClient = { status: 'PENDING_IPPIS' } as Client;
  const ippisRecordWithSalary = { salary: 100000 } as unknown as IppisRecord;

  it('passes when every rule passes', async () => {
    const service = buildService();
    const result = await service.check(verifiedClient, ippisRecordWithSalary, 200000);
    expect(result.eligible).toBe(true);
  });

  it('fails fast on the first failing rule without evaluating later rules', async () => {
    const service = buildService();
    const result = await service.check(unverifiedClient, ippisRecordWithSalary, 999999999);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/VERIFIED/);
  });

  it('fails the salary cap rule when the amount exceeds it', async () => {
    const service = buildService();
    const result = await service.check(verifiedClient, ippisRecordWithSalary, 400000);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/exceeds/);
  });
});

import { computeAvailableAdminActions } from './available-admin-actions.util';
import { LoanRequestStatus } from '../generated/prisma/client';

describe('computeAvailableAdminActions', () => {
  it('returns confirmCode for PENDING', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.PENDING)).toEqual(['confirmCode']);
  });

  it('returns approve and reject for CONFIRMED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.CONFIRMED)).toEqual(['approve', 'reject']);
  });

  it('returns disburse for APPROVED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.APPROVED)).toEqual(['disburse']);
  });

  it('returns an empty array for DISBURSED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.DISBURSED)).toEqual([]);
  });

  it('returns an empty array for REJECTED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.REJECTED)).toEqual([]);
  });

  it('returns an empty array for FAILED', () => {
    expect(computeAvailableAdminActions(LoanRequestStatus.FAILED)).toEqual([]);
  });
});

import { LoanRequestStatus } from '../generated/prisma/client';

export function computeAvailableAdminActions(status: LoanRequestStatus): string[] {
  switch (status) {
    case LoanRequestStatus.PENDING:
      return ['confirmCode'];
    case LoanRequestStatus.CONFIRMED:
      return ['approve', 'reject'];
    case LoanRequestStatus.APPROVED:
      return ['disburse'];
    default:
      return [];
  }
}

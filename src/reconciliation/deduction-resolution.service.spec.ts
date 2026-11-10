import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { DEDUCTION_REFUND, DeductionResolutionService } from './deduction-resolution.service';

const record = (over: Record<string, unknown> = {}) => ({
  id: 'ded-1', agency: 'NPF', staffId: 'PF1', period: '2026-08', elementName: 'LOAN REPAYMENT', amount: 15000,
  matchStatus: 'REQUEST_NOT_DISBURSED', resolution: null, rawFields: null, ...over,
});
const appLoan = { id: 'cl-1', agency: 'NPF', disbursementDate: new Date(2026, 8, 3), maturationDate: new Date(2027, 7, 3) };

describe('DeductionResolutionService', () => {
  let prisma: Record<string, Record<string, jest.Mock>>;
  let wallet: { credit: jest.Mock };
  let approvals: { register: jest.Mock; submit: jest.Mock; countPending: jest.Mock; pendingFor: jest.Mock };
  let audit: { record: jest.Mock };
  let imported: { reconcileAll: jest.Mock };
  let app: { reconcileAll: jest.Mock };
  let service: DeductionResolutionService;
  let refundHandler: (payload: Record<string, unknown>, approval: never, deciderId: string) => Promise<void>;

  beforeEach(() => {
    prisma = {
      loanRepaymentRecord: {
        findUnique: jest.fn().mockResolvedValue(record()),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'ded-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      clientLoan: { findUnique: jest.fn().mockResolvedValue(appLoan) },
      loan: { findUnique: jest.fn() },
      ippisRecord: { findFirst: jest.fn().mockResolvedValue({ employeeName: 'A', clientOnboarding: { clientId: 'client-1' } }) },
    };
    wallet = { credit: jest.fn().mockResolvedValue({ id: 'entry-1' }) };
    approvals = {
      register: jest.fn((action, handler) => { if (action === DEDUCTION_REFUND) refundHandler = handler; }),
      submit: jest.fn().mockResolvedValue({ pendingApproval: true }),
      countPending: jest.fn().mockResolvedValue(0),
      pendingFor: jest.fn().mockResolvedValue(new Map()),
    };
    audit = { record: jest.fn() };
    imported = { reconcileAll: jest.fn() };
    app = { reconcileAll: jest.fn() };
    service = new DeductionResolutionService(prisma as never, wallet as never, approvals as never, audit as never, imported as never, app as never);
    service.onModuleInit();
  });

  describe('assign', () => {
    it('counts the deduction toward the loan in another month, and reconciles app loans again', async () => {
      await service.assign('ded-1', { clientLoanId: 'cl-1', period: '2026-09', note: 'Disbursed late' }, 'admin-1');
      expect(prisma.loanRepaymentRecord.updateMany).toHaveBeenCalledWith({
        where: { id: 'ded-1', resolution: null },
        data: expect.objectContaining({ resolution: 'ASSIGNED', clientLoanId: 'cl-1', loanId: null, appliedPeriod: '2026-09', resolvedById: 'admin-1' }),
      });
      expect(app.reconcileAll).toHaveBeenCalled();
      expect(imported.reconcileAll).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'reconciliation.deduction.assign' }));
    });

    it('refuses a month outside the loan', async () => {
      await expect(service.assign('ded-1', { clientLoanId: 'cl-1' }, 'admin-1')).rejects.toThrow('2026-08 is outside');
      expect(prisma.loanRepaymentRecord.updateMany).not.toHaveBeenCalled();
    });

    it('needs exactly one loan', async () => {
      await expect(service.assign('ded-1', {}, 'admin-1')).rejects.toThrow('Give either clientLoanId or loanId');
      await expect(service.assign('ded-1', { clientLoanId: 'cl-1', loanId: 'l' }, 'admin-1')).rejects.toThrow('Give either');
    });

    it('refuses a deduction already dealt with, or already matched', async () => {
      prisma.loanRepaymentRecord.findUnique.mockResolvedValue(record({ resolution: 'DISMISSED' }));
      await expect(service.assign('ded-1', { clientLoanId: 'cl-1', period: '2026-09' }, 'a')).rejects.toThrow(ConflictException);
      prisma.loanRepaymentRecord.findUnique.mockResolvedValue(record({ matchStatus: 'MATCHED' }));
      await expect(service.assign('ded-1', { clientLoanId: 'cl-1', period: '2026-09' }, 'a')).rejects.toThrow('already counts');
    });

    it('waits while a refund of it is pending approval', async () => {
      approvals.countPending.mockResolvedValue(1);
      await expect(service.assign('ded-1', { clientLoanId: 'cl-1', period: '2026-09' }, 'a')).rejects.toThrow('waiting for approval');
    });
  });

  describe('refund', () => {
    it('sends it for wallet approval rather than paying at once', async () => {
      await service.requestRefund('ded-1', 'No loan', 'admin-1');
      expect(approvals.submit).toHaveBeenCalledWith(
        expect.objectContaining({ action: DEDUCTION_REFUND, requiredPermission: 'approvals:wallets', targetId: 'ded-1', payload: { note: 'No loan' } }),
      );
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('needs an app account to refund to', async () => {
      prisma.ippisRecord.findFirst.mockResolvedValue(null);
      await expect(service.requestRefund('ded-1', undefined, 'admin-1')).rejects.toThrow(UnprocessableEntityException);
    });

    it('on approval, claims the deduction, credits the wallet and keeps the entry', async () => {
      await refundHandler({ note: 'No loan' }, { targetId: 'ded-1', requestedById: 'maker' } as never, 'checker');
      expect(prisma.loanRepaymentRecord.updateMany).toHaveBeenCalledWith({
        where: { id: 'ded-1', resolution: null },
        data: expect.objectContaining({ resolution: 'REFUNDED', resolvedById: 'checker' }),
      });
      expect(wallet.credit).toHaveBeenCalledWith('client-1', 15000, expect.stringContaining('NPF 2026-08'), { actorType: 'ADMIN', actorId: 'checker' });
      expect(prisma.loanRepaymentRecord.update).toHaveBeenCalledWith({ where: { id: 'ded-1' }, data: { refundWalletEntryId: 'entry-1' } });
    });

    it('on approval, undoes the claim when the credit fails', async () => {
      wallet.credit.mockRejectedValue(new Error('down'));
      await expect(refundHandler({}, { targetId: 'ded-1', requestedById: 'm' } as never, 'c')).rejects.toThrow('down');
      expect(prisma.loanRepaymentRecord.update).toHaveBeenCalledWith({
        where: { id: 'ded-1' },
        data: { resolution: null, resolutionNote: null, resolvedById: null, resolvedAt: null },
      });
    });

    it('on approval, pays nothing if someone dealt with it in the meantime', async () => {
      prisma.loanRepaymentRecord.updateMany.mockResolvedValue({ count: 0 });
      await expect(refundHandler({}, { targetId: 'ded-1', requestedById: 'm' } as never, 'c')).rejects.toThrow('already been dealt with');
      expect(wallet.credit).not.toHaveBeenCalled();
    });
  });

  it('dismiss records the note and who dismissed it', async () => {
    await service.dismiss('ded-1', 'Payroll error, reversed by agency', 'admin-1');
    expect(prisma.loanRepaymentRecord.updateMany).toHaveBeenCalledWith({
      where: { id: 'ded-1', resolution: null },
      data: expect.objectContaining({ resolution: 'DISMISSED', resolutionNote: 'Payroll error, reversed by agency', resolvedById: 'admin-1' }),
    });
  });
});

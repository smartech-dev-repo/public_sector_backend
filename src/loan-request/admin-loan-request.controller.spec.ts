import { ApprovalHandler, ApprovalsService } from '../approvals/approvals.service';
import { AdminLoanRequestController } from './admin-loan-request.controller';
import { LoanRequestService } from './loan-request.service';
import { AuditLogService } from '../audit/audit-log.service';
import { JwtPayload } from '../auth/jwt-payload.interface';

describe('AdminLoanRequestController', () => {
  let controller: AdminLoanRequestController;
  let loanRequestService: {
    listAll: jest.Mock;
    approve: jest.Mock;
    reject: jest.Mock;
    disburse: jest.Mock;
    findById: jest.Mock;
    adminConfirmByCode: jest.Mock;
    requireStatus: jest.Mock;
    checkConfirmationCode: jest.Mock;
    confirmAfterApproval: jest.Mock;
  };
  let auditLogService: { record: jest.Mock };
  const adminReq = { user: { sub: 'admin-1', type: 'admin' } as JwtPayload };

  let approvalsService: { submit: jest.Mock; register: jest.Mock };
  let registered: Record<string, ApprovalHandler>;

  beforeEach(() => {
    loanRequestService = {
      listAll: jest.fn(),
      approve: jest.fn(),
      reject: jest.fn(),
      disburse: jest.fn(),
      findById: jest.fn(),
      adminConfirmByCode: jest.fn(),
      requireStatus: jest.fn(),
      checkConfirmationCode: jest.fn().mockResolvedValue(undefined),
      confirmAfterApproval: jest.fn().mockResolvedValue(undefined),
    };
    registered = {};
    approvalsService = {
      submit: jest.fn().mockResolvedValue({ pendingApproval: true, approvalId: 'ap1', status: 'PENDING' }),
      register: jest.fn((action: string, handler: ApprovalHandler) => {
        registered[action] = handler;
      }),
    };
    auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminLoanRequestController(
      loanRequestService as unknown as LoanRequestService,
      auditLogService as unknown as AuditLogService,
      approvalsService as unknown as ApprovalsService,
    );
  });

  describe('actions sent for approval', () => {
    const loan = { id: 'lr1', amount: 100000, tenorMonths: 6, type: 'ORIGINATION', client: { phone: '+234', onboarding: { employeeName: 'Ada' } } };
    const approval = (targetId = 'lr1') => ({ targetId, requestedById: 'maker-1' }) as never;

    beforeEach(() => {
      loanRequestService.requireStatus.mockResolvedValue(loan);
      controller.onModuleInit();
    });

    it('approve only creates a request; no money moves', async () => {
      await controller.approve('lr1', {}, adminReq);

      expect(loanRequestService.approve).not.toHaveBeenCalled();
      expect(approvalsService.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'loan-request.approve',
          requiredPermission: 'approvals:loans',
          targetId: 'lr1',
          requestedById: 'admin-1',
        }),
      );
    });

    it('disburse only creates a request', async () => {
      await controller.disburse('lr1', {}, adminReq);
      expect(loanRequestService.disburse).not.toHaveBeenCalled();
      expect(approvalsService.submit).toHaveBeenCalledWith(expect.objectContaining({ action: 'loan-request.disburse' }));
    });

    it('checks the code straight away and never stores it', async () => {
      await controller.confirmCode('lr1', { code: '123456' }, adminReq);

      expect(loanRequestService.checkConfirmationCode).toHaveBeenCalledWith('lr1', '123456');
      expect(JSON.stringify(approvalsService.submit.mock.calls)).not.toContain('123456');
    });

    it('runs the real action as the checker once approved, passing the date through', async () => {
      await registered['loan-request.approve']({ disbursedAt: '2026-01-01T00:00:00.000Z' }, approval(), 'checker-1');

      expect(loanRequestService.approve).toHaveBeenCalledWith('lr1', new Date('2026-01-01T00:00:00.000Z'));
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'loan-request.approve', actorId: 'checker-1', metadata: { requestedById: 'maker-1' } }),
      );
    });

    it('passes undefined when no date was given', async () => {
      await registered['loan-request.disburse']({ disbursedAt: null }, approval(), 'checker-1');
      expect(loanRequestService.disburse).toHaveBeenCalledWith('lr1', undefined);
    });

    it('confirms without needing the code again', async () => {
      await registered['loan-request.confirm_code']({}, approval(), 'checker-1');
      expect(loanRequestService.confirmAfterApproval).toHaveBeenCalledWith('lr1');
    });
  });

  describe('findOne', () => {
    it('delegates to LoanRequestService.findById', () => {
      loanRequestService.findById.mockResolvedValue({ id: 'lr1' });
      controller.findOne('lr1');
      expect(loanRequestService.findById).toHaveBeenCalledWith('lr1');
    });
  });

});

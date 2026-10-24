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
  };
  let auditLogService: { record: jest.Mock };
  const adminReq = { user: { sub: 'admin-1', type: 'admin' } as JwtPayload };

  beforeEach(() => {
    loanRequestService = {
      listAll: jest.fn(),
      approve: jest.fn(),
      reject: jest.fn(),
      disburse: jest.fn(),
      findById: jest.fn(),
      adminConfirmByCode: jest.fn(),
    };
    auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminLoanRequestController(
      loanRequestService as unknown as LoanRequestService,
      auditLogService as unknown as AuditLogService,
    );
  });

  describe('findOne', () => {
    it('delegates to LoanRequestService.findById', () => {
      loanRequestService.findById.mockResolvedValue({ id: 'lr1' });
      controller.findOne('lr1');
      expect(loanRequestService.findById).toHaveBeenCalledWith('lr1');
    });
  });

  describe('approve', () => {
    it('passes undefined when disbursedAt is omitted', async () => {
      loanRequestService.approve.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.approve('lr1', {}, adminReq);
      expect(loanRequestService.approve).toHaveBeenCalledWith('lr1', undefined);
    });

    it('converts a supplied disbursedAt string to a Date', async () => {
      loanRequestService.approve.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.approve('lr1', { disbursedAt: '2026-01-01T00:00:00.000Z' }, adminReq);
      expect(loanRequestService.approve).toHaveBeenCalledWith('lr1', new Date('2026-01-01T00:00:00.000Z'));
    });

    it('records an audit log entry', async () => {
      loanRequestService.approve.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.approve('lr1', {}, adminReq);
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'loan-request.approve', targetId: 'lr1', actorId: 'admin-1' }),
      );
    });
  });

  describe('disburse', () => {
    it('converts a supplied disbursedAt string to a Date', async () => {
      loanRequestService.disburse.mockResolvedValue({ id: 'lr1', status: 'DISBURSED' });
      await controller.disburse('lr1', { disbursedAt: '2026-01-01T00:00:00.000Z' }, adminReq);
      expect(loanRequestService.disburse).toHaveBeenCalledWith('lr1', new Date('2026-01-01T00:00:00.000Z'));
    });
  });

  describe('confirmCode', () => {
    it('delegates to LoanRequestService.adminConfirmByCode and records an audit log entry', async () => {
      loanRequestService.adminConfirmByCode.mockResolvedValue(undefined);

      const result = await controller.confirmCode('lr1', { code: '123456' }, adminReq);

      expect(loanRequestService.adminConfirmByCode).toHaveBeenCalledWith('lr1', '123456');
      expect(auditLogService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'loan-request.confirm-code', targetId: 'lr1', actorId: 'admin-1' }),
      );
      expect(result).toEqual({ confirmed: true });
    });
  });
});

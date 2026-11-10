import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditLogService } from '../audit/audit-log.service';
import {
  AuditActorType,
  LoanRepaymentRecord,
  Prisma,
  RepaymentMatchStatus,
  RepaymentResolution,
} from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { ReconciliationService } from './reconciliation.service';
import { ClientLoanReconciliationService } from './client-loan-reconciliation.service';
import { isWithinLoanPeriod, MATCH_STATUS_MESSAGES, staffKey } from './deduction-match.util';
import { AssignDeductionDto, DeductionView } from './dto/deduction.dto';

export const DEDUCTION_REFUND = 'reconciliation.deduction-refund';

export interface DeductionFilters {
  view?: DeductionView;
  matchStatus?: RepaymentMatchStatus;
  resolution?: RepaymentResolution;
  agency?: string;
  period?: string;
  search?: string;
}

const UNRESOLVED: Prisma.LoanRepaymentRecordWhereInput = {
  matchStatus: { not: RepaymentMatchStatus.MATCHED },
  resolution: null,
};

const naira = (amount: number) => `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;

/** Payroll deductions that match no running loan, and what admins do with them. */
@Injectable()
export class DeductionResolutionService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly walletService: WalletService,
    private readonly approvalsService: ApprovalsService,
    private readonly auditLogService: AuditLogService,
    private readonly reconciliationService: ReconciliationService,
    private readonly clientLoanReconciliationService: ClientLoanReconciliationService,
  ) {}

  onModuleInit() {
    this.approvalsService.register(DEDUCTION_REFUND, (payload, approval, deciderId) =>
      this.completeRefund(approval.targetId, deciderId, approval.requestedById, payload.note as string | undefined),
    );
  }

  async list(filters: DeductionFilters, pagination: { page: number; limit: number }) {
    const { page, limit } = pagination;
    const scope: Prisma.LoanRepaymentRecordWhereInput = {
      agency: filters.agency,
      period: filters.period,
      staffId: filters.search ? { contains: filters.search, mode: 'insensitive' } : undefined,
    };
    const view = filters.view ?? 'UNRESOLVED';
    const where: Prisma.LoanRepaymentRecordWhereInput = {
      ...scope,
      ...(view === 'UNRESOLVED' ? UNRESOLVED : view === 'RESOLVED' ? { resolution: { not: null } } : {}),
      ...(filters.matchStatus ? { matchStatus: filters.matchStatus } : {}),
      ...(filters.resolution ? { resolution: filters.resolution } : {}),
    };

    const [rows, total, unresolved, resolved] = await Promise.all([
      this.prisma.loanRepaymentRecord.findMany({
        where,
        include: {
          loan: { select: { id: true, customerName: true, agency: true } },
          clientLoan: { select: { id: true, agency: true } },
          resolvedBy: { select: { id: true, fullName: true } },
        },
        orderBy: [{ period: 'desc' }, { agency: 'asc' }, { staffId: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.loanRepaymentRecord.count({ where }),
      this.prisma.loanRepaymentRecord.groupBy({
        by: ['matchStatus'],
        where: { ...scope, ...UNRESOLVED },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      this.prisma.loanRepaymentRecord.groupBy({
        by: ['resolution'],
        where: { ...scope, resolution: { not: null } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const [people, pending] = await Promise.all([this.staffFor(rows), this.approvalsService.pendingFor(rows.map((r) => r.id))]);
    const data = rows.map((row) => {
      const person = people.get(staffKey(row.agency, row.staffId));
      return {
        ...row,
        reason: row.matchStatus === RepaymentMatchStatus.MATCHED ? null : MATCH_STATUS_MESSAGES[row.matchStatus],
        employeeName: person?.employeeName ?? employeeNameFromUpload(row),
        clientId: person?.clientId ?? null,
        pendingRefund: pending.get(row.id) ?? null,
      };
    });

    const summary = {
      unresolved: {
        count: unresolved.reduce((sum, g) => sum + g._count._all, 0),
        amount: round2(unresolved.reduce((sum, g) => sum + Number(g._sum.amount ?? 0), 0)),
        byReason: Object.fromEntries(
          unresolved.map((g) => [g.matchStatus, { count: g._count._all, amount: Number(g._sum.amount ?? 0) }]),
        ),
      },
      resolved: Object.fromEntries(
        resolved.map((g) => [g.resolution, { count: g._count._all, amount: Number(g._sum.amount ?? 0) }]),
      ),
    };
    return { ...buildPaginatedResult(data, total, page, limit), summary };
  }

  /** The loans of the deduction's staff number, in any sector, and whether each runs in its month. */
  async candidates(id: string) {
    const record = await this.find(id);
    const [clientLoans, loans] = await Promise.all([
      this.prisma.clientLoan.findMany({
        where: { staffId: { equals: record.staffId, mode: 'insensitive' } },
        orderBy: { disbursementDate: 'desc' },
      }),
      this.prisma.loan.findMany({
        where: { ippisNumber: { equals: record.staffId, mode: 'insensitive' } },
        orderBy: { disbursementDate: 'desc' },
      }),
    ]);
    const covers = (loan: Parameters<typeof isWithinLoanPeriod>[1]) =>
      record.period ? isWithinLoanPeriod(record.period, loan) : false;
    return {
      deduction: { id: record.id, agency: record.agency, staffId: record.staffId, period: record.period, amount: Number(record.amount) },
      loans: [
        ...clientLoans.map((loan) => ({
          source: 'APP' as const,
          clientLoanId: loan.id,
          loanId: null,
          agency: loan.agency,
          principalAmount: Number(loan.principalAmount),
          principalBalance: Number(loan.principalBalance),
          status: loan.status,
          disbursementDate: loan.disbursementDate,
          maturationDate: loan.maturationDate,
          settledAt: null,
          sameSector: loan.agency === record.agency,
          coversPeriod: covers(loan),
        })),
        ...loans.map((loan) => ({
          source: 'IMPORTED' as const,
          clientLoanId: null,
          loanId: loan.id,
          agency: loan.agency,
          principalAmount: Number(loan.loanAmount),
          principalBalance: Number(loan.principalBalance),
          status: null,
          disbursementDate: loan.disbursementDate,
          maturationDate: loan.maturationDate,
          settledAt: loan.settledAt,
          sameSector: loan.agency === record.agency,
          coversPeriod: covers(loan),
        })),
      ],
    };
  }

  /** Counts the deduction toward a loan, in its own month or another one, and reconciles that loan again. */
  async assign(id: string, dto: AssignDeductionDto, adminId: string) {
    if (!dto.clientLoanId === !dto.loanId) {
      throw new BadRequestException('Give either clientLoanId or loanId');
    }
    const record = await this.findUnresolved(id);
    const period = dto.period ?? record.period;
    if (!period) {
      throw new BadRequestException('This deduction has no month, so give the month it counts toward');
    }

    const target = dto.clientLoanId
      ? await this.prisma.clientLoan.findUnique({ where: { id: dto.clientLoanId } })
      : await this.prisma.loan.findUnique({ where: { id: dto.loanId } });
    if (!target) {
      throw new NotFoundException('Loan not found');
    }
    if (!isWithinLoanPeriod(period, target)) {
      throw new UnprocessableEntityException(`${period} is outside this loan's repayment months`);
    }

    await this.claim(id, {
      resolution: RepaymentResolution.ASSIGNED,
      clientLoanId: dto.clientLoanId ?? null,
      loanId: dto.loanId ?? null,
      appliedPeriod: period === record.period ? null : period,
      resolutionNote: dto.note ?? null,
      resolvedById: adminId,
      resolvedAt: new Date(),
    });
    if (dto.clientLoanId) await this.clientLoanReconciliationService.reconcileAll();
    else await this.reconciliationService.reconcileAll();

    await this.audit(adminId, 'reconciliation.deduction.assign', record, {
      clientLoanId: dto.clientLoanId ?? null,
      loanId: dto.loanId ?? null,
      period,
      note: dto.note ?? null,
    });
    return this.detail(id);
  }

  /** Sends a refund to the client's wallet for approval; it is paid when approved. */
  async requestRefund(id: string, note: string | undefined, adminId: string) {
    const record = await this.findUnresolved(id);
    const client = await this.clientFor(record);
    const amount = Number(record.amount);
    return this.approvalsService.submit({
      action: DEDUCTION_REFUND,
      requiredPermission: 'approvals:wallets',
      targetType: 'LoanRepaymentRecord',
      targetId: record.id,
      summary: {
        title: 'Refund unmatched payroll deduction',
        subject: client.employeeName,
        details: [
          { label: 'Amount', value: naira(amount) },
          { label: 'Sector', value: record.agency },
          { label: 'Month', value: record.period ?? '—' },
          { label: 'Reason', value: MATCH_STATUS_MESSAGES[record.matchStatus as Exclude<RepaymentMatchStatus, 'MATCHED'>] },
          ...(note ? [{ label: 'Note', value: note }] : []),
        ],
        link: `/dashboard/clients/${client.clientId}`,
      },
      payload: { note: note ?? null },
      requestedById: adminId,
    });
  }

  async dismiss(id: string, note: string, adminId: string) {
    const record = await this.findUnresolved(id);
    await this.claim(id, {
      resolution: RepaymentResolution.DISMISSED,
      resolutionNote: note,
      resolvedById: adminId,
      resolvedAt: new Date(),
    });
    await this.audit(adminId, 'reconciliation.deduction.dismiss', record, { note });
    return this.detail(id);
  }

  /** Runs on approval. Rechecks the deduction, which may have been dealt with since the request. */
  private async completeRefund(id: string, deciderId: string, requestedById: string, note?: string) {
    const record = await this.findUnresolved(id, { ignorePendingRefund: true });
    const client = await this.clientFor(record);
    const amount = Number(record.amount);

    // Claimed first, so two approvals can never both pay.
    await this.claim(id, {
      resolution: RepaymentResolution.REFUNDED,
      resolutionNote: note ?? null,
      resolvedById: deciderId,
      resolvedAt: new Date(),
    });
    let entryId: string;
    try {
      const entry = await this.walletService.credit(
        client.clientId,
        amount,
        `Refund of payroll deduction with no running loan — ${record.agency} ${record.period ?? ''}`.trim(),
        { actorType: AuditActorType.ADMIN, actorId: deciderId },
      );
      entryId = entry.id;
    } catch (error) {
      await this.prisma.loanRepaymentRecord.update({
        where: { id },
        data: { resolution: null, resolutionNote: null, resolvedById: null, resolvedAt: null },
      });
      throw error;
    }
    await this.prisma.loanRepaymentRecord.update({ where: { id }, data: { refundWalletEntryId: entryId } });
    await this.audit(deciderId, 'reconciliation.deduction.refund', record, {
      amount,
      clientId: client.clientId,
      walletEntryId: entryId,
      requestedById,
      note: note ?? null,
    });
  }

  private async detail(id: string) {
    return this.prisma.loanRepaymentRecord.findUniqueOrThrow({
      where: { id },
      include: {
        loan: { select: { id: true, customerName: true, agency: true } },
        clientLoan: { select: { id: true, agency: true } },
        resolvedBy: { select: { id: true, fullName: true } },
      },
    });
  }

  private async find(id: string): Promise<LoanRepaymentRecord> {
    const record = await this.prisma.loanRepaymentRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Deduction not found');
    return record;
  }

  private async findUnresolved(id: string, options: { ignorePendingRefund?: boolean } = {}) {
    const record = await this.find(id);
    if (record.resolution) {
      throw new ConflictException(`This deduction has already been ${record.resolution.toLowerCase()}`);
    }
    if (record.matchStatus === RepaymentMatchStatus.MATCHED) {
      throw new ConflictException('This deduction already counts toward a running loan');
    }
    if (!options.ignorePendingRefund && (await this.approvalsService.countPending(id, [DEDUCTION_REFUND])) > 0) {
      throw new ConflictException('A refund of this deduction is waiting for approval');
    }
    return record;
  }

  /** Sets the resolution only if nobody else has resolved it in the meantime. */
  private async claim(id: string, data: Prisma.LoanRepaymentRecordUncheckedUpdateManyInput) {
    const { count } = await this.prisma.loanRepaymentRecord.updateMany({ where: { id, resolution: null }, data });
    if (count === 0) {
      throw new ConflictException('This deduction has already been dealt with');
    }
  }

  private async clientFor(record: LoanRepaymentRecord) {
    const ippis = await this.prisma.ippisRecord.findFirst({
      where: { agency: record.agency, staffId: { equals: record.staffId, mode: 'insensitive' } },
      select: { employeeName: true, clientOnboarding: { select: { clientId: true } } },
    });
    const clientId = ippis?.clientOnboarding?.clientId;
    if (!clientId) {
      throw new UnprocessableEntityException('This staff number has no app account, so there is no wallet to refund to');
    }
    return { clientId, employeeName: ippis.employeeName };
  }

  /** The IPPIS name and app account of each row's staff number. */
  private async staffFor(rows: { agency: string; staffId: string }[]) {
    if (rows.length === 0) return new Map<string, { employeeName: string; clientId: string | null }>();
    const records = await this.prisma.ippisRecord.findMany({
      where: { OR: rows.map((r) => ({ agency: r.agency, staffId: { equals: r.staffId, mode: 'insensitive' as const } })) },
      select: { agency: true, staffId: true, employeeName: true, clientOnboarding: { select: { clientId: true } } },
    });
    return new Map(
      records.map((r) => [
        staffKey(r.agency, r.staffId),
        { employeeName: r.employeeName, clientId: r.clientOnboarding?.clientId ?? null },
      ]),
    );
  }

  private audit(actorId: string, action: string, record: LoanRepaymentRecord, metadata: Prisma.InputJsonObject) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId,
      action,
      targetType: 'LoanRepaymentRecord',
      targetId: record.id,
      metadata: {
        agency: record.agency,
        period: record.period,
        amount: Number(record.amount),
        matchStatus: record.matchStatus,
        ...metadata,
      },
    });
  }
}

function employeeNameFromUpload(row: { rawFields: Prisma.JsonValue }): string | null {
  const raw = row.rawFields as Record<string, unknown> | null;
  const name = raw?.['employee name'];
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

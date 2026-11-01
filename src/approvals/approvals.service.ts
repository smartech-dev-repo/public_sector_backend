import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../audit/audit-log.service';
import { errorReason } from '../audit/audit-outcome';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { isUniqueConstraintError } from '../common/is-unique-constraint-error.util';
import { ApprovalRequest, ApprovalStatus, AuditActorType, Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ApprovalSummary {
  title: string;
  subject?: string;
  details?: { label: string; value: string }[];
  link?: string;
}

export interface ApprovalSubmission {
  action: string;
  requiredPermission: string;
  targetType: string;
  targetId: string;
  summary: ApprovalSummary;
  payload?: Prisma.InputJsonObject;
  requestedById: string;
  /** Allow several open requests on one record, such as wallet credits. */
  allowParallel?: boolean;
}

/** Runs the real action once a second admin agrees. Receives what the maker submitted. */
export type ApprovalHandler = (payload: Record<string, unknown>, approval: ApprovalRequest, deciderId: string) => Promise<void>;

const PEOPLE_INCLUDE = {
  requestedBy: { select: { id: true, fullName: true, email: true } },
  assignedTo: { select: { id: true, fullName: true, email: true } },
  decidedBy: { select: { id: true, fullName: true, email: true } },
} as const;

/** Requests this admin can act on now: assigned to them, or open to their permissions. */
export const toDecideWhere = (user: JwtPayload): Prisma.ApprovalRequestWhereInput => ({
  status: ApprovalStatus.PENDING,
  requestedById: { not: user.sub },
  OR: [{ assignedToId: user.sub }, { assignedToId: null, requiredPermission: { in: user.permissions ?? [] } }],
});

@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly notificationService: NotificationService,
  ) {}

  /** Each feature registers the actions it sends for approval, which keeps this module free of them. */
  register(action: string, handler: ApprovalHandler): void {
    this.handlers.set(action, handler);
  }

  private audit(actorId: string, action: string, approval: ApprovalRequest, metadata: Prisma.InputJsonObject = {}) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId,
      action,
      targetType: 'ApprovalRequest',
      targetId: approval.id,
      metadata: { request: (approval.summary as unknown as ApprovalSummary).title, ...metadata },
    });
  }

  async submit(submission: ApprovalSubmission) {
    const { allowParallel, payload, summary, ...fields } = submission;
    try {
      const approval = await this.prisma.approvalRequest.create({
        data: {
          ...fields,
          summary: summary as unknown as Prisma.InputJsonObject,
          payload: payload ?? {},
          pendingKey: allowParallel ? null : `${fields.action}:${fields.targetId}`,
        },
      });
      await this.audit(fields.requestedById, 'approval.requested', approval);
      await this.notificationService.notify({
        category: 'approvals',
        title: 'Approval needed',
        body: summary.subject ? `${summary.title}: ${summary.subject}` : summary.title,
        link: `/dashboard/approvals/${approval.id}`,
        targetPermissions: [fields.requiredPermission],
        excludeAdminId: fields.requestedById,
      });
      return { pendingApproval: true, approvalId: approval.id, status: approval.status };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('This is already waiting for approval');
      }
      throw error;
    }
  }

  // Decisions use live permissions, so a newly granted approver can act at once
  // and one who lost the permission can't keep deciding on an old token.
  private async withCurrentPermissions(user: JwtPayload): Promise<JwtPayload> {
    return { ...user, permissions: await this.notificationService.currentPermissions(user.sub) };
  }

  /** The open request on each record, so lists can show it is waiting. */
  async pendingFor(targetIds: string[]) {
    const pending = await this.prisma.approvalRequest.findMany({
      where: { status: ApprovalStatus.PENDING, targetId: { in: targetIds } },
      select: { id: true, targetId: true, summary: true },
    });
    return new Map(
      pending.map((row) => [row.targetId, { id: row.id, title: (row.summary as unknown as ApprovalSummary).title }]),
    );
  }

  /** How many requests are open on one record, for actions that can run side by side. */
  countPending(targetId: string, actions: string[]): Promise<number> {
    return this.prisma.approvalRequest.count({
      where: { status: ApprovalStatus.PENDING, targetId, action: { in: actions } },
    });
  }

  private accessWhere(user: JwtPayload): Prisma.ApprovalRequestWhereInput {
    return {
      OR: [{ requiredPermission: { in: user.permissions ?? [] } }, { requestedById: user.sub }, { assignedToId: user.sub }],
    };
  }

  async list(
    caller: JwtPayload,
    filters: { view?: 'to_decide' | 'mine'; status?: ApprovalStatus; action?: string },
    pagination: { page: number; limit: number },
  ) {
    const user = await this.withCurrentPermissions(caller);
    const { page, limit } = pagination;
    const views: Record<string, Prisma.ApprovalRequestWhereInput> = {
      to_decide: toDecideWhere(user),
      mine: { requestedById: user.sub },
    };
    const where: Prisma.ApprovalRequestWhereInput = {
      ...(filters.view ? views[filters.view] : this.accessWhere(user)),
      ...(filters.status ? { status: filters.status } : {}),
      action: filters.action,
    };

    const [data, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        include: PEOPLE_INCLUDE,
        omit: { payload: true, pendingKey: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    return buildPaginatedResult(data, total, page, limit);
  }

  async findById(caller: JwtPayload, id: string) {
    const user = await this.withCurrentPermissions(caller);
    const approval = await this.prisma.approvalRequest.findFirst({
      where: { id, ...this.accessWhere(user) },
      include: PEOPLE_INCLUDE,
      omit: { payload: true, pendingKey: true },
    });
    if (!approval) {
      throw new NotFoundException('Approval request not found');
    }
    const isApprover = (user.permissions ?? []).includes(approval.requiredPermission);
    const pending = approval.status === ApprovalStatus.PENDING;
    const canDecide =
      pending && approval.requestedById !== user.sub && (approval.assignedToId ? approval.assignedToId === user.sub : isApprover);
    return { ...approval, canDecide, canAssign: pending && isApprover, isMine: approval.requestedById === user.sub };
  }

  private async loadForDecision(user: JwtPayload, id: string) {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!approval) {
      throw new NotFoundException('Approval request not found');
    }
    if (approval.requestedById === user.sub) {
      throw new ForbiddenException('You cannot decide your own request. Another admin must do it.');
    }
    if (approval.assignedToId) {
      if (approval.assignedToId !== user.sub) {
        throw new ForbiddenException('This request is assigned to another admin');
      }
    } else if (!(user.permissions ?? []).includes(approval.requiredPermission)) {
      throw new ForbiddenException('You do not have permission to decide this request');
    }
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new ConflictException('This request has already been decided');
    }
    return approval;
  }

  // Claims the row so two admins deciding at once can't both act on it.
  private async claim(id: string, data: Prisma.ApprovalRequestUncheckedUpdateManyInput): Promise<void> {
    const { count } = await this.prisma.approvalRequest.updateMany({
      where: { id, status: ApprovalStatus.PENDING },
      data: { ...data, decidedAt: new Date(), pendingKey: null },
    });
    if (count === 0) {
      throw new ConflictException('This request has already been decided');
    }
  }

  private tellRequester(approval: ApprovalRequest, title: string, body?: string) {
    return this.notificationService.notify({
      category: 'approvals',
      title,
      body: body ?? (approval.summary as unknown as ApprovalSummary).title,
      link: `/dashboard/approvals/${approval.id}`,
      recipientAdminId: approval.requestedById,
    });
  }

  async approve(caller: JwtPayload, id: string, note?: string) {
    const user = await this.withCurrentPermissions(caller);
    const approval = await this.loadForDecision(user, id);
    const handler = this.handlers.get(approval.action);
    if (!handler) {
      throw new ConflictException('This kind of request can no longer be carried out');
    }

    await this.claim(id, { status: ApprovalStatus.APPROVED, decidedById: user.sub, decisionNote: note });
    try {
      await handler(approval.payload as Record<string, unknown>, approval, user.sub);
    } catch (error) {
      // The action rechecks the record, which may have moved on since the maker asked.
      const reason = errorReason(error) ?? 'The action could not be completed';
      await this.prisma.approvalRequest.update({
        where: { id },
        data: { status: ApprovalStatus.FAILED, failureReason: reason },
      });
      await this.audit(user.sub, 'approval.failed', approval, { error: reason });
      await this.tellRequester(approval, 'Approved, but it could not be completed', reason);
      throw new ConflictException(reason);
    }

    await this.audit(user.sub, 'approval.approved', approval);
    await this.tellRequester(approval, 'Your request was approved');
    return { status: ApprovalStatus.APPROVED };
  }

  async reject(caller: JwtPayload, id: string, note: string) {
    const user = await this.withCurrentPermissions(caller);
    const approval = await this.loadForDecision(user, id);
    await this.claim(id, { status: ApprovalStatus.REJECTED, decidedById: user.sub, decisionNote: note });
    await this.audit(user.sub, 'approval.rejected', approval, { note });
    await this.tellRequester(approval, 'Your request was rejected', note);
    return { status: ApprovalStatus.REJECTED };
  }

  private async loadForAssigning(user: JwtPayload, id: string) {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!approval) {
      throw new NotFoundException('Approval request not found');
    }
    // Only approvers assign, so a maker can never pick their own checker.
    if (!(user.permissions ?? []).includes(approval.requiredPermission)) {
      throw new ForbiddenException('You do not have permission to assign this request');
    }
    if (approval.status !== ApprovalStatus.PENDING) {
      throw new ConflictException('This request has already been decided');
    }
    return approval;
  }

  async listAssignees(caller: JwtPayload, id: string) {
    const user = await this.withCurrentPermissions(caller);
    const approval = await this.loadForAssigning(user, id);
    return this.prisma.adminUser.findMany({
      where: { isActive: true, id: { not: approval.requestedById } },
      select: { id: true, fullName: true, email: true },
      orderBy: { fullName: 'asc' },
    });
  }

  async assign(caller: JwtPayload, id: string, assigneeId: string | null) {
    const user = await this.withCurrentPermissions(caller);
    const approval = await this.loadForAssigning(user, id);
    if (assigneeId === approval.requestedById) {
      throw new ForbiddenException('The admin who made this request cannot decide it');
    }

    const assignee = assigneeId
      ? await this.prisma.adminUser.findFirst({ where: { id: assigneeId, isActive: true }, select: { id: true, fullName: true } })
      : null;
    if (assigneeId && !assignee) {
      throw new NotFoundException('Admin not found');
    }

    const { count } = await this.prisma.approvalRequest.updateMany({
      where: { id, status: ApprovalStatus.PENDING },
      data: { assignedToId: assigneeId },
    });
    if (count === 0) {
      throw new ConflictException('This request has already been decided');
    }

    await this.audit(user.sub, assignee ? 'approval.assigned' : 'approval.unassigned', approval, { assignee: assignee?.fullName ?? null });
    if (assignee && assignee.id !== user.sub) {
      const summary = approval.summary as unknown as ApprovalSummary;
      await this.notificationService.notify({
        category: 'approvals',
        title: 'A request was assigned to you',
        body: summary.subject ? `${summary.title}: ${summary.subject}` : summary.title,
        link: `/dashboard/approvals/${approval.id}`,
        recipientAdminId: assignee.id,
      });
    }
    return { assignedToId: assigneeId };
  }

  async cancel(user: JwtPayload, id: string) {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!approval || approval.requestedById !== user.sub) {
      throw new NotFoundException('Approval request not found');
    }
    await this.claim(id, { status: ApprovalStatus.CANCELLED });
    await this.audit(user.sub, 'approval.cancelled', approval);
    return { status: ApprovalStatus.CANCELLED };
  }
}

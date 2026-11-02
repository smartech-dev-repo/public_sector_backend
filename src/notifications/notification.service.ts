import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import { JwtPayload } from '../auth/jwt-payload.interface';

export const SUPER_ADMIN_ROLE_NAME = 'SUPER_ADMIN';

export interface NewNotification {
  category: string;
  title: string;
  body: string;
  link: string;
  /** Everyone holding any of these sees it. */
  targetPermissions?: string[];
  /** Or just this one admin. */
  recipientAdminId?: string;
  /** The person who caused it doesn't need telling. */
  excludeAdminId?: string;
}

export interface AuditEventForNotification {
  action: string;
  actorType: string;
  actorId?: string;
  targetId?: string;
  metadata?: unknown;
}

type NotificationRule = (event: AuditEventForNotification) => Omit<NewNotification, 'excludeAdminId'> | null;

const securityRule = (title: string): NotificationRule => () => ({
  category: 'security',
  title,
  body: 'Open the audit trail for details.',
  link: '/dashboard/reports',
  targetPermissions: ['audit:read'],
});

// Everything worth telling an admin about is already an audit event, so one place
// decides who hears about what and each feature needs no extra code.
const NOTIFICATION_RULES: Record<string, NotificationRule> = {
  'loan-request.code_confirmed': (event) => ({
    category: 'loans',
    title: 'Loan confirmed by the client',
    body: 'This request is ready for review.',
    link: `/dashboard/loan-requests/${event.targetId}`,
    targetPermissions: ['loan-requests:review'],
  }),
  'agent.application_submitted': (event) => ({
    category: 'agents',
    title: 'New agent application',
    body: 'An application is waiting for review.',
    link: `/dashboard/agent/${event.targetId}`,
    targetPermissions: ['agents:review'],
  }),
  'client.onboarding.face_match': (event) =>
    (event.metadata as { faceMatchPassed?: boolean } | undefined)?.faceMatchPassed === false
      ? {
          category: 'clients',
          title: 'Client needs manual review',
          body: 'Their face match did not pass.',
          link: `/dashboard/clients/${event.targetId}`,
          targetPermissions: ['clients:review'],
        }
      : null,
  'document.upload.reviewed': () => ({
    category: 'uploads',
    title: 'Upload ready to confirm',
    body: 'A file finished review and is waiting for a decision.',
    link: '/dashboard/broadsheet',
    targetPermissions: ['documents:read'],
  }),
  'document.upload.failed': () => ({
    category: 'uploads',
    title: 'Upload failed',
    body: 'A file could not be processed.',
    link: '/dashboard/broadsheet',
    targetPermissions: ['documents:read'],
  }),
  'sector.created': (event) => ({
    category: 'loans',
    title: `New sector added: ${(event.metadata as { code?: string } | undefined)?.code}`,
    body: 'Add it to the loan products it should get. Until then its staff see no products.',
    link: '/dashboard/loan-terms',
    targetPermissions: ['loan-products:manage'],
  }),
  'session.reuse_detected': securityRule('A stolen session may be in use'),
  'agent.client_access.denied': securityRule("An agent was blocked from another agent's client"),
  'admin.2fa.disabled': securityRule('An admin turned off two-factor sign-in'),
};

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read from the database, not the sign-in token, so a permission just granted
   * or removed takes effect here straight away.
   */
  async currentPermissions(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { role: { select: { name: true, permissions: { select: { permission: { select: { key: true } } } } } } },
    });
    // SUPER_ADMIN always holds everything, including permissions added after its rows were written.
    if (admin?.role.name === SUPER_ADMIN_ROLE_NAME) {
      const permissions = await this.prisma.permission.findMany({ select: { key: true } });
      return permissions.map((permission) => permission.key);
    }
    return admin?.role.permissions.map((row) => row.permission.key) ?? [];
  }

  /** Never throws: a notification problem must not affect the action that caused it. */
  async notify(notification: NewNotification): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: { ...notification, targetPermissions: notification.targetPermissions ?? [] },
      });
    } catch (error) {
      this.logger.error(`Could not create notification: ${error instanceof Error ? error.message : error}`);
    }
  }

  async fromAuditEvent(event: AuditEventForNotification): Promise<void> {
    const notification = NOTIFICATION_RULES[event.action]?.(event);
    if (notification) {
      await this.notify({ ...notification, excludeAdminId: event.actorType === 'ADMIN' ? event.actorId : undefined });
    }
  }

  private async visibleTo(user: JwtPayload): Promise<Prisma.NotificationWhereInput> {
    const permissions = await this.currentPermissions(user.sub);
    return {
      AND: [
        { OR: [{ recipientAdminId: user.sub }, { recipientAdminId: null, targetPermissions: { hasSome: permissions } }] },
        { OR: [{ excludeAdminId: null }, { excludeAdminId: { not: user.sub } }] },
      ],
    };
  }

  async list(
    user: JwtPayload,
    filters: { category?: string; unread?: boolean },
    pagination: { page: number; limit: number },
  ) {
    const { page, limit } = pagination;
    const where: Prisma.NotificationWhereInput = {
      ...(await this.visibleTo(user)),
      category: filters.category,
      reads: filters.unread ? { none: { adminId: user.sub } } : undefined,
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        include: { reads: { where: { adminId: user.sub }, select: { readAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where }),
    ]);

    const data = rows.map(({ reads, targetPermissions: _permissions, recipientAdminId: _recipient, excludeAdminId: _excluded, ...row }) => ({
      ...row,
      readAt: reads[0]?.readAt ?? null,
    }));
    return buildPaginatedResult(data, total, page, limit);
  }

  /** The counts behind the bell and the menu badges. */
  async summary(user: JwtPayload) {
    const permissions = await this.currentPermissions(user.sub);
    const visible = await this.visibleTo(user);
    const [groups, pendingApprovals, myPendingRequests] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['category'],
        where: { ...visible, reads: { none: { adminId: user.sub } } },
        _count: { _all: true },
      }),
      this.prisma.approvalRequest.count({
        where: {
          status: 'PENDING',
          requestedById: { not: user.sub },
          OR: [{ assignedToId: user.sub }, { assignedToId: null, requiredPermission: { in: permissions } }],
        },
      }),
      this.prisma.approvalRequest.count({ where: { status: 'PENDING', requestedById: user.sub } }),
    ]);

    const byCategory = Object.fromEntries(groups.map((group) => [group.category, group._count._all]));
    const unread = groups.reduce((sum, group) => sum + group._count._all, 0);
    return { unread, byCategory, pendingApprovals, myPendingRequests };
  }

  async markRead(user: JwtPayload, id: string): Promise<void> {
    const notification = await this.prisma.notification.findFirst({ where: { id, ...(await this.visibleTo(user)) } });
    if (!notification) {
      throw new NotFoundException('Notification not found');
    }
    await this.prisma.notificationRead.upsert({
      where: { notificationId_adminId: { notificationId: id, adminId: user.sub } },
      update: {},
      create: { notificationId: id, adminId: user.sub },
    });
  }

  async markAllRead(user: JwtPayload): Promise<void> {
    const unread = await this.prisma.notification.findMany({
      where: { ...(await this.visibleTo(user)), reads: { none: { adminId: user.sub } } },
      select: { id: true },
    });
    await this.prisma.notificationRead.createMany({
      data: unread.map(({ id }) => ({ notificationId: id, adminId: user.sub })),
      skipDuplicates: true,
    });
  }
}

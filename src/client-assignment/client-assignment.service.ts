import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SmsService } from '../sms/sms.service';
import { SmsType } from '../sms/sms-type';
import { PushService } from '../push/push.service';
import { NotificationService } from '../notifications/notification.service';
import {
  AuditActorType,
  ClientAssignmentKind,
  Prisma,
} from '../generated/prisma/client';
import { generateNumericCode } from '../common/generate-numeric-code.util';
import { hashToken } from '../common/opaque-token.util';
import { validNigerianPhone } from '../common/normalize-nigerian-phone.util';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { clientScope } from '../common/client-scope.util';

const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const LINK_CODE_MAX_ATTEMPTS = 5;

export interface Actor {
  type: 'ADMIN' | 'AGENT' | 'SYSTEM';
  id?: string;
}

const maskPhone = (phone: string) =>
  `${phone.slice(0, 4)}•••••${phone.slice(-3)}`;

/**
 * Who looks after a client now: an agent and an admin. Both start as whoever onboarded
 * (or created) the client and change only here, with a reason, kept as history. Who
 * originally onboarded the client never changes.
 */
@Injectable()
export class ClientAssignmentService {
  private readonly logger = new Logger(ClientAssignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
    private readonly smsService: SmsService,
    private readonly pushService: PushService,
    private readonly notificationService: NotificationService,
    private readonly config: ConfigService,
  ) {}

  async getAssignment(clientId: string) {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: {
        id: true,
        assignedAgent: {
          select: { id: true, fullName: true, email: true, phone: true },
        },
        assignedAdmin: { select: { id: true, fullName: true, email: true } },
        onboarding: {
          select: {
            onboardedByAgent: { select: { id: true, fullName: true } },
            onboardedByAdmin: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!client) throw new NotFoundException('Client not found');
    const history = await this.prisma.clientAssignment.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { ...client, history: await this.withNames(history) };
  }

  /** Admin changes the assigned agent and/or admin of one client. */
  async updateAssignment(
    clientId: string,
    change: { agentId?: string | null; adminId?: string | null },
    reason: string,
    actor: Actor,
  ) {
    if (change.agentId === undefined && change.adminId === undefined) {
      throw new BadRequestException('Send agentId and/or adminId');
    }
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: { id: true, assignedAgentId: true, assignedAdminId: true },
    });
    if (!client) throw new NotFoundException('Client not found');
    if (change.agentId) await this.assertAssignableAgent(change.agentId);
    if (change.adminId) await this.assertAssignableAdmin(change.adminId);

    const entries: Prisma.ClientAssignmentCreateManyInput[] = [];
    const data: Prisma.ClientUncheckedUpdateInput = {};
    if (
      change.agentId !== undefined &&
      change.agentId !== client.assignedAgentId
    ) {
      data.assignedAgentId = change.agentId;
      entries.push(
        this.entry(
          clientId,
          'AGENT',
          client.assignedAgentId,
          change.agentId,
          reason,
          actor,
        ),
      );
    }
    if (
      change.adminId !== undefined &&
      change.adminId !== client.assignedAdminId
    ) {
      data.assignedAdminId = change.adminId;
      entries.push(
        this.entry(
          clientId,
          'ADMIN',
          client.assignedAdminId,
          change.adminId,
          reason,
          actor,
        ),
      );
    }
    if (entries.length === 0)
      throw new ConflictException('The client is already assigned this way');

    await this.prisma.$transaction([
      this.prisma.client.update({ where: { id: clientId }, data }),
      this.prisma.clientAssignment.createMany({ data: entries }),
    ]);
    await this.afterAssigned(entries, actor);
    return this.getAssignment(clientId);
  }

  /** Move an agent's clients (all, or the listed ones) to another agent. */
  async reassignAgentClients(
    fromAgentId: string,
    toAgentId: string,
    clientIds: string[] | undefined,
    reason: string,
    actor: Actor,
    user?: JwtPayload,
  ) {
    if (fromAgentId === toAgentId)
      throw new BadRequestException(
        'Choose a different agent to move the clients to',
      );
    const from = await this.prisma.agent.findUnique({
      where: { id: fromAgentId },
      select: { id: true },
    });
    if (!from) throw new NotFoundException('Agent not found');
    await this.assertAssignableAgent(toAgentId);

    const scope = clientScope(user);
    const clients = await this.prisma.client.findMany({
      where: {
        AND: [
          { assignedAgentId: fromAgentId },
          clientIds ? { id: { in: clientIds } } : {},
          scope ?? {},
        ],
      },
      select: { id: true },
    });
    if (clientIds && clients.length !== new Set(clientIds).size) {
      throw new UnprocessableEntityException(
        'Some of these clients are not assigned to this agent, or are outside your records',
      );
    }
    if (clients.length === 0) return { moved: 0 };

    const entries = clients.map((c) =>
      this.entry(c.id, 'AGENT', fromAgentId, toAgentId, reason, actor),
    );
    await this.prisma.$transaction([
      this.prisma.client.updateMany({
        where: { id: { in: clients.map((c) => c.id) } },
        data: { assignedAgentId: toAgentId },
      }),
      this.prisma.clientAssignment.createMany({ data: entries }),
    ]);
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: actor.id,
      action: 'clients.reassigned',
      targetType: 'Agent',
      targetId: fromAgentId,
      metadata: { toAgentId, count: clients.length, reason },
    });
    await this.pushService.sendToPrincipal('AGENT', toAgentId, {
      title: 'Clients assigned to you',
      body: `${clients.length} ${clients.length === 1 ? 'client was' : 'clients were'} moved to you.`,
      data: { type: 'CLIENTS_ASSIGNED', count: String(clients.length) },
    });
    return { moved: clients.length };
  }

  async assignableAgents(q?: string) {
    const term = q?.trim();
    return this.prisma.agent.findMany({
      where: {
        status: 'APPROVED',
        canOnboardClients: true,
        ...(term
          ? {
              OR: [
                { fullName: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        _count: { select: { assignedClients: true } },
      },
      orderBy: { fullName: 'asc' },
      take: 20,
    });
  }

  async assignableAdmins(q?: string) {
    const term = q?.trim();
    return this.prisma.adminUser.findMany({
      where: {
        isActive: true,
        ...(term
          ? {
              OR: [
                { fullName: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        fullName: true,
        email: true,
        _count: { select: { assignedClients: true } },
      },
      orderBy: { fullName: 'asc' },
      take: 20,
    });
  }

  // ---- An agent linking an unassigned client, with the client's consent ----

  /** Texts the client a code. The agent links them by entering it. */
  async requestAgentLink(
    agentId: string,
    by: { phone?: string; ippisNumber?: string },
  ) {
    if (!by.phone && !by.ippisNumber)
      throw new BadRequestException(
        "Give the client's phone number or IPPIS number",
      );
    const client = await this.findClient(by);
    if (!client)
      throw new NotFoundException(
        'No client found. If they are new, onboard them instead.',
      );
    if (client.assignedAgentId === agentId)
      throw new ConflictException('This client is already linked to you');
    if (client.assignedAgentId)
      throw new ConflictException(
        'This client is already linked to another agent. Ask an admin to reassign them.',
      );

    const agent = await this.prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { fullName: true },
    });
    const code = generateNumericCode(6);
    const request = await this.prisma.clientLinkRequest.create({
      data: {
        clientId: client.id,
        agentId,
        codeHash: hashToken(code),
        expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
      },
    });
    const name = agent.fullName.replace(/[^\x20-\x7E]/g, '').slice(0, 30);
    await this.smsService.send({
      type: SmsType.OTP,
      phone: client.phone,
      message: `Moneyfield: agent ${name} wants to link your account. Give them code ${code} only if you agree. Expires in 15 mins.`,
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: 'client.link_requested',
      targetType: 'Client',
      targetId: client.id,
    });
    const devEcho =
      this.config.get('EMAIL_CODE_DEV_ECHO') === 'true' ||
      this.config.get('ENABLE_MOCK_OTP') === 'true';
    return {
      requestId: request.id,
      sentTo: maskPhone(client.phone),
      expiresAt: request.expiresAt,
      ...(devEcho ? { devCode: code } : {}),
    };
  }

  async confirmAgentLink(agentId: string, requestId: string, code: string) {
    const request = await this.prisma.clientLinkRequest.findUnique({
      where: { id: requestId },
    });
    if (!request || request.agentId !== agentId)
      throw new NotFoundException('Link request not found');
    if (request.consumedAt)
      throw new ConflictException('This code has already been used');
    if (
      request.expiresAt < new Date() ||
      request.attempts >= LINK_CODE_MAX_ATTEMPTS
    ) {
      throw new UnauthorizedException(
        'This code has expired. Ask for a new one.',
      );
    }
    if (request.codeHash !== hashToken(code)) {
      await this.prisma.clientLinkRequest.update({
        where: { id: requestId },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Wrong code');
    }

    // Only if still unassigned: two agents can't both win the same client.
    const claimed = await this.prisma.client.updateMany({
      where: { id: request.clientId, assignedAgentId: null },
      data: { assignedAgentId: agentId },
    });
    await this.prisma.clientLinkRequest.update({
      where: { id: requestId },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0)
      throw new ConflictException(
        'This client was linked to another agent in the meantime',
      );

    await this.prisma.clientAssignment.create({
      data: this.entry(
        request.clientId,
        'AGENT',
        null,
        agentId,
        'Linked by the agent with the client’s code',
        { type: 'AGENT', id: agentId },
      ),
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: 'client.linked_to_agent',
      targetType: 'Client',
      targetId: request.clientId,
    });
    return { linked: true, clientId: request.clientId };
  }

  // ---- Helpers ----

  private async findClient(by: { phone?: string; ippisNumber?: string }) {
    const select = { id: true, phone: true, assignedAgentId: true } as const;
    if (by.phone) {
      const phone = validNigerianPhone(by.phone);
      if (!phone)
        throw new BadRequestException('Enter a valid Nigerian mobile number');
      return this.prisma.client.findUnique({ where: { phone }, select });
    }
    return this.prisma.client.findFirst({
      where: {
        onboarding: {
          ippisRecord: {
            staffId: { equals: by.ippisNumber!.trim(), mode: 'insensitive' },
          },
        },
      },
      select,
    });
  }

  private async assertAssignableAgent(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { status: true, canOnboardClients: true },
    });
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.status !== 'APPROVED' || !agent.canOnboardClients) {
      throw new UnprocessableEntityException(
        'Clients can only be assigned to approved agents who can onboard clients',
      );
    }
  }

  private async assertAssignableAdmin(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { isActive: true },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    if (!admin.isActive)
      throw new UnprocessableEntityException(
        'Clients can only be assigned to active admins',
      );
  }

  private entry(
    clientId: string,
    kind: ClientAssignmentKind,
    fromId: string | null,
    toId: string | null,
    reason: string,
    actor: Actor,
  ) {
    return {
      clientId,
      kind,
      fromId,
      toId,
      reason,
      actorType: actor.type,
      actorId: actor.id ?? null,
    };
  }

  private async afterAssigned(
    entries: Prisma.ClientAssignmentCreateManyInput[],
    actor: Actor,
  ) {
    for (const e of entries) {
      await this.auditLogService.recordSafely({
        actorType:
          actor.type === 'ADMIN' ? AuditActorType.ADMIN : AuditActorType.AGENT,
        actorId: actor.id,
        action:
          e.kind === 'AGENT'
            ? 'client.agent_assigned'
            : 'client.admin_assigned',
        targetType: 'Client',
        targetId: e.clientId,
        metadata: {
          from: e.fromId ?? null,
          to: e.toId ?? null,
          reason: e.reason,
        },
      });
      if (e.kind === 'AGENT' && e.toId) {
        await this.pushService.sendToPrincipal('AGENT', e.toId, {
          title: 'A client was assigned to you',
          body: 'Open My Clients to see them.',
          data: { type: 'CLIENT_ASSIGNED', clientId: e.clientId },
        });
      }
      if (e.kind === 'ADMIN' && e.toId && e.toId !== actor.id) {
        await this.notificationService.notify({
          category: 'clients',
          title: 'A client was assigned to you',
          body: e.reason,
          link: `/dashboard/clients/${e.clientId}`,
          recipientAdminId: e.toId,
        });
      }
    }
  }

  private async withNames<
    T extends {
      kind: ClientAssignmentKind;
      fromId: string | null;
      toId: string | null;
      actorType: string;
      actorId: string | null;
    },
  >(rows: T[]) {
    const agentIds = new Set<string>();
    const adminIds = new Set<string>();
    rows.forEach((r) => {
      [r.fromId, r.toId].forEach(
        (id) => id && (r.kind === 'AGENT' ? agentIds : adminIds).add(id),
      );
      if (r.actorId)
        (r.actorType === 'AGENT' ? agentIds : adminIds).add(r.actorId);
    });
    const [agents, admins] = await Promise.all([
      this.prisma.agent.findMany({
        where: { id: { in: [...agentIds] } },
        select: { id: true, fullName: true },
      }),
      this.prisma.adminUser.findMany({
        where: { id: { in: [...adminIds] } },
        select: { id: true, fullName: true },
      }),
    ]);
    const agentName = new Map(agents.map((a) => [a.id, a.fullName]));
    const adminName = new Map(admins.map((a) => [a.id, a.fullName]));
    const name = (kind: 'AGENT' | 'ADMIN', id: string | null) =>
      id ? ((kind === 'AGENT' ? agentName : adminName).get(id) ?? null) : null;
    return rows.map((r) => ({
      ...r,
      fromName: name(r.kind, r.fromId),
      toName: name(r.kind, r.toId),
      actorName:
        r.actorType === 'SYSTEM'
          ? 'System'
          : name(r.actorType === 'AGENT' ? 'AGENT' : 'ADMIN', r.actorId),
    }));
  }
}

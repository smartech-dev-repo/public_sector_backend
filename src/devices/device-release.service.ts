import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';
import { SmsType } from '../sms/sms-type';
import { SessionService } from '../session/session.service';
import { NotificationService } from '../notifications/notification.service';
import {
  FILE_STORAGE_PROVIDER,
  FileStorageProvider,
} from '../file-storage/file-storage-provider.interface';
import {
  AuditActorType,
  Device,
  DeviceReleaseRequest,
  Prisma,
  SessionPrincipalType,
} from '../generated/prisma/client';
import { buildPaginatedResult } from '../common/pagination/paginated-result';
import {
  BoundPrincipalType,
  DeviceBindingService,
} from './device-binding.service';
import { DeviceInfo, describeDevice } from './device-info.util';
import { deviceReleasedEmail, deviceReleasedSms } from './device-messages';

export interface ProofFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface DeviceListFilters {
  principalType?: BoundPrincipalType;
  principalId?: string;
  status?: 'ACTIVE' | 'RELEASED';
  q?: string;
}

const ACTOR: Record<BoundPrincipalType, AuditActorType> = {
  AGENT: AuditActorType.AGENT,
  CLIENT: AuditActorType.CLIENT,
};
export const PROOF_TYPES = ['image/jpeg', 'image/png', 'application/pdf'];

/**
 * Asking for a bound device to be released, and admins releasing one. A release always
 * carries a reason (and optionally a proof file: a letter, a police report, a screenshot),
 * signs the account out everywhere, and tells the owner.
 */
@Injectable()
export class DeviceReleaseService {
  private readonly logger = new Logger(DeviceReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly binding: DeviceBindingService,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly sessionService: SessionService,
    private readonly notificationService: NotificationService,
    @Inject(FILE_STORAGE_PROVIDER)
    private readonly storage: FileStorageProvider,
  ) {}

  // ---- Requests from agents and clients ----

  /** From the refused device, with the token the sign-in refusal returned. */
  async requestFromRefusedDevice(releaseToken: string, reason?: string) {
    const { principalType, principalId, device } =
      this.binding.verifyReleaseToken(releaseToken);
    return this.fileRequest(principalType, principalId, reason, device);
  }

  /** From the bound device, signed in: "I'm moving to a new phone". */
  async requestFromSignedIn(
    principalType: BoundPrincipalType,
    principalId: string,
    reason?: string,
  ) {
    return this.fileRequest(principalType, principalId, reason);
  }

  private async fileRequest(
    principalType: BoundPrincipalType,
    principalId: string,
    reason: string | undefined,
    device?: DeviceInfo,
  ) {
    const active = await this.binding.activeDevice(principalType, principalId);
    if (!active)
      throw new ConflictException(
        'No device is linked to this account. Sign in on the device you want to use.',
      );

    const requested = device
      ? {
          requestedFingerprint: device.fingerprint,
          requestedDeviceName: device.deviceName ?? null,
          requestedBrand: device.brand ?? null,
          requestedModel: device.model ?? null,
          requestedPlatform: device.platform ?? null,
          requestedImei: device.imei ?? null,
        }
      : {};

    // One open request per account: a newer one replaces the details of the old.
    const pending = await this.prisma.deviceReleaseRequest.findFirst({
      where: { principalType, principalId, status: 'PENDING' },
    });
    const request = pending
      ? await this.prisma.deviceReleaseRequest.update({
          where: { id: pending.id },
          data: {
            deviceId: active.id,
            reason: reason ?? pending.reason,
            ...requested,
          },
        })
      : await this.prisma.deviceReleaseRequest.create({
          data: {
            principalType,
            principalId,
            deviceId: active.id,
            reason: reason ?? null,
            ...requested,
          },
        });

    await this.auditLogService.recordSafely({
      actorType: ACTOR[principalType],
      actorId: principalId,
      action: 'device.release_requested',
      targetType: 'DeviceReleaseRequest',
      targetId: request.id,
      metadata: {
        linked: describeDevice(active),
        requested: device ? describeDevice(device) : null,
      },
    });
    if (!pending) {
      const who = await this.principalName(principalType, principalId);
      await this.notificationService.notify({
        category: 'security',
        title: 'Device release requested',
        body: `${who} (${principalType === 'AGENT' ? 'agent' : 'client'}) asked to remove ${describeDevice(active)}${device ? ` and use ${describeDevice(device)}` : ''}.`,
        link: '/dashboard/devices',
        targetPermissions: ['devices:manage'],
      });
    }
    return {
      id: request.id,
      status: request.status,
      createdAt: request.createdAt,
    };
  }

  // ---- Admin ----

  async listRequests(
    status: string | undefined,
    pagination: { page: number; limit: number },
  ) {
    const where: Prisma.DeviceReleaseRequestWhereInput = {
      status: (status as DeviceReleaseRequest['status']) ?? undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.deviceReleaseRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      this.prisma.deviceReleaseRequest.count({ where }),
    ]);
    const devices = await this.prisma.device.findMany({
      where: {
        id: {
          in: rows.map((r) => r.deviceId).filter((id): id is string => !!id),
        },
      },
    });
    const byId = new Map(devices.map((d) => [d.id, d]));
    const people = await this.people(rows);
    const data = rows.map((row) => ({
      ...row,
      requestedImei: undefined,
      hasRequestedImei: !!row.requestedImei,
      device: row.deviceId ? this.publicDevice(byId.get(row.deviceId)) : null,
      principal: people.get(`${row.principalType}:${row.principalId}`) ?? null,
    }));
    return buildPaginatedResult(data, total, pagination.page, pagination.limit);
  }

  async listDevices(
    filters: DeviceListFilters,
    pagination: { page: number; limit: number },
  ) {
    const principalIds = filters.q
      ? await this.searchPrincipals(filters.q, filters.principalType)
      : undefined;
    const where: Prisma.DeviceWhereInput = {
      principalType: filters.principalType,
      principalId:
        filters.principalId ??
        (principalIds ? { in: principalIds } : undefined),
      status: filters.status,
    };
    const [rows, total] = await Promise.all([
      this.prisma.device.findMany({
        where,
        orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
        skip: (pagination.page - 1) * pagination.limit,
        take: pagination.limit,
      }),
      this.prisma.device.count({ where }),
    ]);
    const people = await this.people(rows);
    // The same phone on other accounts is worth flagging: one handset signing many clients in.
    const shared = await this.prisma.device.groupBy({
      by: ['fingerprint'],
      where: {
        fingerprint: { in: rows.map((r) => r.fingerprint) },
        status: 'ACTIVE',
      },
      _count: { _all: true },
    });
    const sharedCount = new Map(
      shared.map((s) => [s.fingerprint, s._count._all]),
    );
    const data = rows.map((row) => ({
      ...this.publicDevice(row),
      principal: people.get(`${row.principalType}:${row.principalId}`) ?? null,
      otherAccountsOnThisDevice: Math.max(
        0,
        (sharedCount.get(row.fingerprint) ?? 1) -
          (row.status === 'ACTIVE' ? 1 : 0),
      ),
    }));
    return buildPaginatedResult(data, total, pagination.page, pagination.limit);
  }

  /** A signed link to the proof an admin attached, for the back office. */
  async proofUrl(kind: 'device' | 'request', id: string) {
    const key =
      kind === 'device'
        ? (
            await this.prisma.device.findUnique({
              where: { id },
              select: { releaseProofKey: true },
            })
          )?.releaseProofKey
        : (
            await this.prisma.deviceReleaseRequest.findUnique({
              where: { id },
              select: { proofKey: true },
            })
          )?.proofKey;
    if (!key) throw new NotFoundException('No proof was attached');
    return { url: await this.storage.getSignedDownloadUrl(key) };
  }

  /** Admin removes a bound device directly. The next device the owner signs in on is bound. */
  async releaseDevice(
    deviceId: string,
    adminId: string,
    reason: string,
    proof?: ProofFile,
  ) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.status !== 'ACTIVE')
      throw new ConflictException('This device has already been released');
    const proofKey = await this.storeProof(proof);
    const released = await this.release(device, adminId, reason, proofKey);
    // An open request for this account is answered by this release.
    await this.prisma.deviceReleaseRequest.updateMany({
      where: {
        principalType: device.principalType,
        principalId: device.principalId,
        status: 'PENDING',
      },
      data: {
        status: 'APPROVED',
        decidedByAdminId: adminId,
        decidedAt: new Date(),
        decisionReason: reason,
        proofKey,
      },
    });
    return this.publicDevice(released);
  }

  /**
   * Approve a request: release the bound device and, when it was filed from a refused
   * device, link that device straight away so nobody else can take the free slot.
   */
  async approveRequest(
    requestId: string,
    adminId: string,
    reason: string,
    proof?: ProofFile,
  ) {
    const request = await this.prisma.deviceReleaseRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== 'PENDING')
      throw new ConflictException(
        `This request is already ${request.status.toLowerCase()}`,
      );
    const principalType = request.principalType as BoundPrincipalType;
    const proofKey = await this.storeProof(proof);

    const active = await this.binding.activeDevice(
      principalType,
      request.principalId,
    );
    if (active) await this.release(active, adminId, reason, proofKey);

    let linked: Device | null = null;
    if (request.requestedFingerprint) {
      linked = await this.prisma.device.create({
        data: {
          principalType,
          principalId: request.principalId,
          fingerprint: request.requestedFingerprint,
          deviceName: request.requestedDeviceName,
          brand: request.requestedBrand,
          model: request.requestedModel,
          platform: request.requestedPlatform,
          imei: request.requestedImei,
        },
      });
    }
    const decided = await this.prisma.deviceReleaseRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        decidedByAdminId: adminId,
        decidedAt: new Date(),
        decisionReason: reason,
        proofKey,
      },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'device.release_request.approved',
      targetType: 'DeviceReleaseRequest',
      targetId: requestId,
      metadata: {
        reason,
        proofAttached: !!proofKey,
        linked: linked ? describeDevice(linked) : null,
      },
    });
    return {
      ...decided,
      requestedImei: undefined,
      linkedDevice: linked ? this.publicDevice(linked) : null,
    };
  }

  async rejectRequest(requestId: string, adminId: string, reason: string) {
    const request = await this.prisma.deviceReleaseRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('Request not found');
    if (request.status !== 'PENDING')
      throw new ConflictException(
        `This request is already ${request.status.toLowerCase()}`,
      );
    const decided = await this.prisma.deviceReleaseRequest.update({
      where: { id: requestId },
      data: {
        status: 'REJECTED',
        decidedByAdminId: adminId,
        decidedAt: new Date(),
        decisionReason: reason,
      },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'device.release_request.rejected',
      targetType: 'DeviceReleaseRequest',
      targetId: requestId,
      metadata: { reason },
    });
    return { ...decided, requestedImei: undefined };
  }

  // ---- Helpers ----

  private async release(
    device: Device,
    adminId: string,
    reason: string,
    proofKey: string | null,
  ) {
    const released = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        releasedByAdminId: adminId,
        releaseReason: reason,
        releaseProofKey: proofKey,
        pushToken: null,
      },
    });
    await this.sessionService.revokeAllForPrincipal(
      device.principalType,
      device.principalId,
      'device_released',
    );
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'device.released',
      targetType: 'Device',
      targetId: device.id,
      metadata: {
        principalType: device.principalType,
        principalId: device.principalId,
        device: describeDevice(device),
        reason,
        proofAttached: !!proofKey,
      },
    });
    await this.tellOwner(device, reason);
    return released;
  }

  private async tellOwner(device: Device, reason: string) {
    try {
      if (device.principalType === 'AGENT') {
        const agent = await this.prisma.agent.findUnique({
          where: { id: device.principalId },
          select: { email: true, fullName: true },
        });
        if (agent)
          await this.emailService.send({
            to: agent.email,
            ...deviceReleasedEmail({
              fullName: agent.fullName,
              released: describeDevice(device),
              reason,
            }),
          });
      } else {
        const client = await this.prisma.client.findUnique({
          where: { id: device.principalId },
          select: { phone: true },
        });
        if (client)
          await this.smsService.send({
            type: SmsType.NOTIFICATION,
            phone: client.phone,
            message: deviceReleasedSms(),
          });
      }
    } catch (error) {
      this.logger.warn(
        `Could not tell the owner of device ${device.id} it was released: ${(error as Error).message}`,
      );
    }
  }

  private async storeProof(proof?: ProofFile): Promise<string | null> {
    if (!proof) return null;
    if (!PROOF_TYPES.includes(proof.mimetype))
      throw new BadRequestException('Proof must be a JPEG, PNG or PDF file');
    const ext =
      proof.mimetype === 'application/pdf'
        ? 'pdf'
        : proof.mimetype === 'image/png'
          ? 'png'
          : 'jpg';
    const key = `device-release-proof/${randomUUID()}.${ext}`;
    await this.storage.putObject(key, proof.buffer);
    return key;
  }

  /** Device fields safe for the back office: no push token, IMEI masked to its last 4. */
  publicDevice(device?: Device | null) {
    if (!device) return null;
    const { pushToken, imei, releaseProofKey, ...rest } = device;
    return {
      ...rest,
      imei: imei ? `••••${imei.slice(-4)}` : null,
      hasPushToken: !!pushToken,
      hasReleaseProof: !!releaseProofKey,
      description: describeDevice(device),
    };
  }

  private async principalName(
    principalType: BoundPrincipalType,
    principalId: string,
  ): Promise<string> {
    if (principalType === 'AGENT') {
      return (
        (
          await this.prisma.agent.findUnique({
            where: { id: principalId },
            select: { fullName: true },
          })
        )?.fullName ?? 'An agent'
      );
    }
    const client = await this.prisma.client.findUnique({
      where: { id: principalId },
      select: { phone: true, onboarding: { select: { employeeName: true } } },
    });
    return client?.onboarding?.employeeName ?? client?.phone ?? 'A client';
  }

  private async people(
    rows: { principalType: SessionPrincipalType; principalId: string }[],
  ) {
    const agentIds = rows
      .filter((r) => r.principalType === 'AGENT')
      .map((r) => r.principalId);
    const clientIds = rows
      .filter((r) => r.principalType === 'CLIENT')
      .map((r) => r.principalId);
    const [agents, clients] = await Promise.all([
      agentIds.length
        ? this.prisma.agent.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, fullName: true, email: true, phone: true },
          })
        : [],
      clientIds.length
        ? this.prisma.client.findMany({
            where: { id: { in: clientIds } },
            select: {
              id: true,
              phone: true,
              onboarding: {
                select: {
                  employeeName: true,
                  ippisRecord: { select: { staffId: true } },
                },
              },
            },
          })
        : [],
    ]);
    const map = new Map<
      string,
      {
        id: string;
        type: 'AGENT' | 'CLIENT';
        name: string;
        phone: string | null;
        email?: string | null;
        ippisNumber?: string | null;
      }
    >();
    agents.forEach((a) =>
      map.set(`AGENT:${a.id}`, {
        id: a.id,
        type: 'AGENT',
        name: a.fullName,
        phone: a.phone,
        email: a.email,
      }),
    );
    clients.forEach((c) =>
      map.set(`CLIENT:${c.id}`, {
        id: c.id,
        type: 'CLIENT',
        name: c.onboarding?.employeeName ?? c.phone,
        phone: c.phone,
        ippisNumber: c.onboarding?.ippisRecord?.staffId ?? null,
      }),
    );
    return map;
  }

  private async searchPrincipals(
    q: string,
    principalType?: BoundPrincipalType,
  ): Promise<string[]> {
    const term = q.trim();
    const [agents, clients] = await Promise.all([
      principalType === 'CLIENT'
        ? []
        : this.prisma.agent.findMany({
            where: {
              OR: [
                { fullName: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term } },
              ],
            },
            select: { id: true },
            take: 200,
          }),
      principalType === 'AGENT'
        ? []
        : this.prisma.client.findMany({
            where: {
              OR: [
                { phone: { contains: term } },
                {
                  onboarding: {
                    employeeName: { contains: term, mode: 'insensitive' },
                  },
                },
                {
                  onboarding: {
                    ippisRecord: {
                      staffId: { contains: term, mode: 'insensitive' },
                    },
                  },
                },
              ],
            },
            select: { id: true },
            take: 200,
          }),
    ]);
    return [...agents, ...clients].map((p) => p.id);
  }
}

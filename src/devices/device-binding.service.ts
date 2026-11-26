import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit-log.service';
import { EmailService } from '../email/email.service';
import { SmsService } from '../sms/sms.service';
import { SmsType } from '../sms/sms-type';
import { PushService } from '../push/push.service';
import {
  AuditActorType,
  Device,
  SessionPrincipalType,
} from '../generated/prisma/client';
import { DeviceInfo, describeDevice } from './device-info.util';
import { DeviceNotRecognisedException } from './device-not-recognised.exception';
import {
  blockedSignInEmail,
  blockedSignInSms,
  DEVICE_REQUIRED_MESSAGE,
} from './device-messages';

export type BoundPrincipalType = 'AGENT' | 'CLIENT';

export interface ReleaseTokenPayload {
  principalType: BoundPrincipalType;
  principalId: string;
  device: DeviceInfo;
}

const RELEASE_TOKEN_TTL = '1h';
/** One alert per refused device per hour, so repeated taps don't flood the owner. */
const ALERT_INTERVAL_MS = 60 * 60 * 1000;

const ACTOR: Record<BoundPrincipalType, AuditActorType> = {
  AGENT: AuditActorType.AGENT,
  CLIENT: AuditActorType.CLIENT,
};

/**
 * Locks each agent and client to one phone. The first device they sign in on is bound;
 * another is refused (403 DEVICE_NOT_RECOGNISED) and the owner is alerted, until an admin
 * releases the bound one. Admins (the web back office) aren't device-bound.
 *
 * Until the apps send X-Device-Id, sign-in without it still works and nothing is bound;
 * set DEVICE_BINDING_REQUIRED=true once every app in use sends it.
 */
@Injectable()
export class DeviceBindingService {
  private readonly logger = new Logger(DeviceBindingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
    private readonly smsService: SmsService,
    private readonly pushService: PushService,
  ) {}

  private get required(): boolean {
    return this.config.get<string>('DEVICE_BINDING_REQUIRED') === 'true';
  }

  private releaseSecret(): string {
    // Its own key, so a release token can never pass as a two-factor pending token.
    return `${this.config.getOrThrow<string>('JWT_TWO_FACTOR_PENDING_SECRET')}:device-release`;
  }

  signReleaseToken(payload: ReleaseTokenPayload): string {
    return this.jwtService.sign(
      { ...payload, sub: payload.principalId },
      { secret: this.releaseSecret(), expiresIn: RELEASE_TOKEN_TTL },
    );
  }

  verifyReleaseToken(token: string): ReleaseTokenPayload {
    try {
      const payload = this.jwtService.verify<ReleaseTokenPayload>(token, {
        secret: this.releaseSecret(),
      });
      return {
        principalType: payload.principalType,
        principalId: payload.principalId,
        device: payload.device,
      };
    } catch {
      throw new UnauthorizedException(
        'This link has expired. Try signing in again to get a new one.',
      );
    }
  }

  async activeDevice(
    principalType: BoundPrincipalType,
    principalId: string,
  ): Promise<Device | null> {
    return this.prisma.device.findFirst({
      where: { principalType, principalId, status: 'ACTIVE' },
    });
  }

  private deviceFields(device: DeviceInfo) {
    return {
      imei: device.imei,
      deviceName: device.deviceName,
      brand: device.brand,
      model: device.model,
      platform: device.platform,
      osVersion: device.osVersion,
      appVersion: device.appVersion,
      ...(device.pushToken ? { pushToken: device.pushToken } : {}),
    };
  }

  /**
   * Call once the credentials are proven, before any token is issued. Returns the bound
   * device (bound now if it's their first), or throws DeviceNotRecognisedException.
   */
  async assertSignInDevice(
    principalType: BoundPrincipalType,
    principalId: string,
    device: DeviceInfo | undefined,
  ): Promise<Device | null> {
    if (!device) {
      if (this.required) throw new BadRequestException(DEVICE_REQUIRED_MESSAGE);
      return null;
    }

    const active = await this.activeDevice(principalType, principalId);
    if (active && active.fingerprint === device.fingerprint) {
      return this.prisma.device.update({
        where: { id: active.id },
        data: { ...this.deviceFields(device), lastSeenAt: new Date() },
      });
    }

    if (!active) {
      try {
        const bound = await this.prisma.device.create({
          data: {
            principalType,
            principalId,
            fingerprint: device.fingerprint,
            ...this.deviceFields(device),
          },
        });
        await this.auditLogService.recordSafely({
          actorType: ACTOR[principalType],
          actorId: principalId,
          action: 'device.bound',
          targetType: 'Device',
          targetId: bound.id,
          metadata: {
            device: describeDevice(bound),
            platform: bound.platform ?? null,
          },
        });
        return bound;
      } catch (error) {
        // Two first sign-ins raced; the partial unique index let one win. Check again.
        const winner = await this.activeDevice(principalType, principalId);
        if (winner?.fingerprint === device.fingerprint) return winner;
        if (!winner) throw error;
        return this.refuse(principalType, principalId, device, winner);
      }
    }

    return this.refuse(principalType, principalId, device, active);
  }

  private async refuse(
    principalType: BoundPrincipalType,
    principalId: string,
    device: DeviceInfo,
    active: Device,
  ): Promise<never> {
    const attempted = describeDevice(device);
    const recentAlert = await this.prisma.auditLog.findFirst({
      where: {
        action: 'device.sign_in_blocked',
        actorId: principalId,
        createdAt: { gte: new Date(Date.now() - ALERT_INTERVAL_MS) },
        metadata: { path: ['fingerprint'], equals: device.fingerprint },
      },
      select: { id: true },
    });
    await this.auditLogService.recordSafely({
      actorType: ACTOR[principalType],
      actorId: principalId,
      action: 'device.sign_in_blocked',
      targetType: 'Device',
      targetId: active.id,
      metadata: {
        fingerprint: device.fingerprint,
        attempted,
        linked: describeDevice(active),
      },
    });
    if (!recentAlert)
      await this.alertOwner(principalType, principalId, attempted, active);
    throw new DeviceNotRecognisedException(
      this.signReleaseToken({ principalType, principalId, device }),
      describeDevice(active),
    );
  }

  private async alertOwner(
    principalType: BoundPrincipalType,
    principalId: string,
    attempted: string,
    active: Device,
  ) {
    try {
      if (principalType === 'AGENT') {
        const agent = await this.prisma.agent.findUnique({
          where: { id: principalId },
          select: { email: true, fullName: true },
        });
        if (agent)
          await this.emailService.send({
            to: agent.email,
            ...blockedSignInEmail({
              fullName: agent.fullName,
              attempted,
              when: new Date(),
            }),
          });
      } else {
        const client = await this.prisma.client.findUnique({
          where: { id: principalId },
          select: { phone: true },
        });
        if (client)
          await this.smsService.send({
            type: SmsType.NOTIFICATION,
            phone: client.phone,
            message: blockedSignInSms(attempted),
          });
      }
    } catch (error) {
      this.logger.warn(
        `Could not alert ${principalType} ${principalId} of a blocked sign-in: ${(error as Error).message}`,
      );
    }
    if (active.pushToken) {
      await this.pushService.sendToDevice(active.id, active.pushToken, {
        title: 'Sign-in blocked',
        body: `Someone tried to sign in to your account on ${attempted}. It was blocked.`,
        data: { type: 'DEVICE_SIGN_IN_BLOCKED' },
      });
    }
  }

  /** The signed-in user updates their push token (FCM rotates it). */
  async updatePushToken(
    principalType: BoundPrincipalType,
    principalId: string,
    fingerprint: string | undefined,
    pushToken: string,
  ) {
    const active = await this.activeDevice(principalType, principalId);
    if (!active || (fingerprint && active.fingerprint !== fingerprint))
      return { updated: false };
    await this.prisma.device.update({
      where: { id: active.id },
      data: { pushToken, lastSeenAt: new Date() },
    });
    return { updated: true };
  }

  /** The bound device of a session principal, for /me endpoints. */
  async summaryFor(principalType: SessionPrincipalType, principalId: string) {
    const [device, pendingRequest] = await Promise.all([
      this.prisma.device.findFirst({
        where: { principalType, principalId, status: 'ACTIVE' },
        select: {
          id: true,
          deviceName: true,
          brand: true,
          model: true,
          platform: true,
          osVersion: true,
          appVersion: true,
          boundAt: true,
          lastSeenAt: true,
        },
      }),
      this.prisma.deviceReleaseRequest.findFirst({
        where: { principalType, principalId, status: 'PENDING' },
        select: {
          id: true,
          reason: true,
          createdAt: true,
          requestedDeviceName: true,
          requestedBrand: true,
          requestedModel: true,
        },
      }),
    ]);
    return { device, pendingReleaseRequest: pendingRequest };
  }
}

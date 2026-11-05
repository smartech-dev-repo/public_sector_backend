import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SessionPrincipalType } from '../generated/prisma/client';
import {
  FcmCredentials,
  fcmMessageBody,
  isDeadTokenError,
  PushMessage,
  serviceAccountAssertion,
} from './fcm-message.util';

export type PushResult = 'sent' | 'no-device' | 'not-configured' | 'failed';

/**
 * Push notifications to the one device an agent or client is bound to, through Firebase
 * Cloud Messaging (Android and iOS). Without FCM_PROJECT_ID / FCM_CLIENT_EMAIL /
 * FCM_PRIVATE_KEY it only logs, so local and test runs need no Firebase project.
 * Never throws: a push is a courtesy, never a reason for the action that sent it to fail.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private credentials(): FcmCredentials | null {
    const projectId = this.config.get<string>('FCM_PROJECT_ID');
    const clientEmail = this.config.get<string>('FCM_CLIENT_EMAIL');
    const privateKey = this.config
      .get<string>('FCM_PRIVATE_KEY')
      ?.replace(/\\n/g, '\n');
    return projectId && clientEmail && privateKey
      ? { projectId, clientEmail, privateKey }
      : null;
  }

  private async token(creds: FcmCredentials): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000)
      return this.accessToken.value;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: serviceAccountAssertion(creds),
      }),
    });
    if (!res.ok) throw new Error(`FCM auth failed with ${res.status}`);
    const json = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = {
      value: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    };
    return json.access_token;
  }

  /** Sends to the principal's ACTIVE device, if it has a push token. */
  async sendToPrincipal(
    principalType: SessionPrincipalType,
    principalId: string,
    message: PushMessage,
  ): Promise<PushResult> {
    const device = await this.prisma.device.findFirst({
      where: {
        principalType,
        principalId,
        status: 'ACTIVE',
        pushToken: { not: null },
      },
    });
    if (!device?.pushToken) return 'no-device';
    return this.sendToDevice(device.id, device.pushToken, message);
  }

  async sendToDevice(
    deviceId: string,
    pushToken: string,
    message: PushMessage,
  ): Promise<PushResult> {
    const creds = this.credentials();
    if (!creds) {
      this.logger.log(
        `Push (not configured) to device ${deviceId}: ${message.title}`,
      );
      return 'not-configured';
    }
    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await this.token(creds)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(fcmMessageBody(pushToken, message)),
        },
      );
      if (res.ok) return 'sent';
      const body = await res.text();
      if (isDeadTokenError(res.status, body)) {
        // The app was uninstalled or the token rotated; the app sends a fresh one at next sign-in.
        await this.prisma.device.updateMany({
          where: { id: deviceId, pushToken },
          data: { pushToken: null },
        });
      }
      this.logger.warn(`Push to device ${deviceId} failed with ${res.status}`);
      return 'failed';
    } catch (error) {
      this.logger.warn(
        `Push to device ${deviceId} failed: ${(error as Error).message}`,
      );
      return 'failed';
    }
  }
}

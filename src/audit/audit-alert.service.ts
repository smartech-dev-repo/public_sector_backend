import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

const ALERT_SUBJECTS: Record<string, string> = {
  'session.reuse_detected': 'A stolen session may be in use',
  'admin.2fa.disabled': 'An admin turned off two-factor sign-in',
  'admin.role.set': "An admin's role was changed",
  'role.permissions.replaced': "A role's permissions were changed",
};

const FAILED_LOGIN_ACTIONS = ['admin.login.failed', 'agent.login.failed'];
const FAILED_LOGIN_THRESHOLD = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const BLOCKED_ACCESS_ACTION = 'agent.client_access.denied';
const BLOCKED_ACCESS_THRESHOLD = 3;
const BLOCKED_ACCESS_WINDOW_MS = 15 * 60 * 1000;

export interface AlertableEvent {
  action: string;
  actorType: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
  ip?: string;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** Emails the active alert recipients about high-risk events. Off when there are none. */
@Injectable()
export class AuditAlertService {
  private readonly logger = new Logger(AuditAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  // AUDIT_ALERT_EMAILS only applies until the first recipient is added on screen,
  // so an existing setup keeps working and the list then has the final say.
  private async recipients(): Promise<string[]> {
    const saved = await this.prisma.alertRecipient.findMany();
    if (saved.length > 0) {
      return saved.filter((recipient) => recipient.isActive).map((recipient) => recipient.email);
    }
    const raw = this.configService.get<string>('AUDIT_ALERT_EMAILS') ?? '';
    return raw.split(',').map((email) => email.trim()).filter(Boolean);
  }

  /** Never throws: an alert problem must not affect the action being audited. */
  async evaluate(event: AlertableEvent): Promise<void> {
    try {
      const subject =
        ALERT_SUBJECTS[event.action] ?? (await this.failedLoginSubject(event)) ?? (await this.blockedAccessSubject(event));
      if (!subject) return;

      const recipients = await this.recipients();
      if (recipients.length === 0) return;

      const lines = [
        `What happened: ${subject}`,
        `Event: ${event.action}`,
        `Time: ${new Date().toISOString()}`,
        `Done by: ${event.actorType}${event.actorId ? ` ${event.actorId}` : ''}`,
        // Blocked access alerts are about the agent, so they name no client.
        event.targetId && event.action !== BLOCKED_ACCESS_ACTION ? `Record: ${event.targetType} ${event.targetId}` : null,
        event.ip ? `IP address: ${event.ip}` : null,
      ].filter((line): line is string => line !== null);

      await Promise.all(
        recipients.map((to) =>
          this.emailService.send({
            to,
            subject: `Security alert: ${subject}`,
            text: lines.join('\n'),
            html: `<p>${lines.map(escapeHtml).join('<br>')}</p><p>Open the Audit Trail in the back office for details.</p>`,
          }),
        ),
      );
    } catch (error) {
      this.logger.error(`Could not send audit alert for ${event.action}: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Like failed sign-ins, this fires only on the attempt that reaches the threshold.
  private async blockedAccessSubject(event: AlertableEvent): Promise<string | null> {
    if (event.action !== BLOCKED_ACCESS_ACTION || !event.actorId) return null;

    const attempts = await this.prisma.auditLog.count({
      where: {
        action: BLOCKED_ACCESS_ACTION,
        actorId: event.actorId,
        createdAt: { gte: new Date(Date.now() - BLOCKED_ACCESS_WINDOW_MS) },
      },
    });
    return attempts === BLOCKED_ACCESS_THRESHOLD
      ? `An agent was blocked from other agents' clients ${BLOCKED_ACCESS_THRESHOLD} times in 15 minutes`
      : null;
  }

  // Fires once, on the attempt that reaches the threshold, so a long attack sends one email.
  private async failedLoginSubject(event: AlertableEvent): Promise<string | null> {
    const email = (event.metadata as { email?: string } | undefined)?.email;
    if (!FAILED_LOGIN_ACTIONS.includes(event.action) || !email) return null;

    const attempts = await this.prisma.auditLog.count({
      where: {
        action: event.action,
        metadata: { path: ['email'], equals: email },
        createdAt: { gte: new Date(Date.now() - FAILED_LOGIN_WINDOW_MS) },
      },
    });
    return attempts === FAILED_LOGIN_THRESHOLD ? `${FAILED_LOGIN_THRESHOLD} failed sign-ins on one account in 15 minutes` : null;
  }
}

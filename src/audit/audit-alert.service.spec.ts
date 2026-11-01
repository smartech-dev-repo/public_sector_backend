import { ConfigService } from '@nestjs/config';
import { AuditAlertService } from './audit-alert.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AuditAlertService', () => {
  let email: { send: jest.Mock };
  let prisma: { auditLog: { count: jest.Mock } };

  const build = (recipients?: string) =>
    new AuditAlertService(
      prisma as unknown as PrismaService,
      email as unknown as EmailService,
      { get: () => recipients } as unknown as ConfigService,
    );

  beforeEach(() => {
    email = { send: jest.fn().mockResolvedValue(undefined) };
    prisma = { auditLog: { count: jest.fn() } };
  });

  it('stays silent when no recipients are configured', async () => {
    await build('').evaluate({ action: 'session.reuse_detected', actorType: 'SYSTEM' });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('emails each recipient about a high-risk event', async () => {
    await build('a@x.test, b@x.test').evaluate({ action: 'admin.2fa.disabled', actorType: 'ADMIN', actorId: 'a1', ip: '1.2.3.4' });
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(email.send.mock.calls[0][0].to).toBe('a@x.test');
    expect(email.send.mock.calls[0][0].text).toContain('1.2.3.4');
  });

  it('ignores everyday events', async () => {
    await build('a@x.test').evaluate({ action: 'role.created', actorType: 'ADMIN' });
    expect(email.send).not.toHaveBeenCalled();
  });

  it('alerts once, on the fifth failed sign-in', async () => {
    const event = { action: 'admin.login.failed', actorType: 'ADMIN', metadata: { email: 'a@x.test' } };
    prisma.auditLog.count.mockResolvedValue(4);
    await build('sec@x.test').evaluate(event);
    prisma.auditLog.count.mockResolvedValue(6);
    await build('sec@x.test').evaluate(event);
    expect(email.send).not.toHaveBeenCalled();

    prisma.auditLog.count.mockResolvedValue(5);
    await build('sec@x.test').evaluate(event);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('alerts once, on the third blocked attempt by the same agent, without naming the client', async () => {
    const event = {
      action: 'agent.client_access.denied',
      actorType: 'AGENT',
      actorId: 'agent-1',
      targetType: 'Client',
      targetId: 'client-secret-id',
      ip: '1.2.3.4',
    };
    prisma.auditLog.count.mockResolvedValue(2);
    await build('sec@x.test').evaluate(event);
    prisma.auditLog.count.mockResolvedValue(4);
    await build('sec@x.test').evaluate(event);
    expect(email.send).not.toHaveBeenCalled();

    prisma.auditLog.count.mockResolvedValue(3);
    await build('sec@x.test').evaluate(event);

    expect(email.send).toHaveBeenCalledTimes(1);
    const message = email.send.mock.calls[0][0];
    expect(message.subject).toContain('blocked');
    expect(message.text).toContain('agent-1');
    expect(message.text).toContain('1.2.3.4');
    expect(JSON.stringify(message)).not.toContain('client-secret-id');
    expect(prisma.auditLog.count.mock.calls[0][0].where.actorId).toBe('agent-1');
  });

  it('never throws when email fails', async () => {
    email.send.mockRejectedValue(new Error('smtp down'));
    await expect(build('a@x.test').evaluate({ action: 'admin.role.set', actorType: 'ADMIN' })).resolves.toBeUndefined();
  });
});

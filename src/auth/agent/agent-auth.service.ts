import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { generateSecret, generateURI, verify } from 'otplib';
import { AuditLogService } from '../../audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AgentStatus, SessionPrincipalType, TwoFactorMethod, AuditActorType } from '../../generated/prisma/client';
import { hashPassword } from '../../common/password-hash.util';
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { ConfigService } from '@nestjs/config';
import { generateNumericCode } from '../../common/generate-numeric-code.util';
import { agentPasswordResetEmail } from '../../email/templates/token-emails';
import {
  twoFactorSetupCodeEmail,
  loginVerificationCodeEmail,
  changePasswordConfirmationCodeEmail,
} from '../../email/templates/verification-code-emails';
import { devCodeEcho } from '../../common/dev-code-echo.util';
import { JwtPayload } from '../jwt-payload.interface';
import { DeviceBindingService } from '../../devices/device-binding.service';
import { SignInMetadata } from '../../common/request-metadata.util';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const CHANGE_PASSWORD_CODE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly configService?: ConfigService,
    private readonly deviceBinding?: DeviceBindingService,
  ) {}

  private recordLoginFailure(reason: string, email?: string, agentId?: string) {
    return this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: reason === 'inactive_account' ? 'agent.login.denied' : 'agent.login.failed',
      targetType: agentId ? 'Agent' : undefined,
      targetId: agentId,
      metadata: { email, reason },
    });
  }

  async login(email: string, password: string, meta?: SignInMetadata) {
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (!agent || agent.status !== 'APPROVED' || !agent.passwordHash) {
      await this.recordLoginFailure(agent ? 'inactive_account' : 'unknown_account', email, agent?.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, agent.passwordHash);
    if (!passwordMatches) {
      await this.recordLoginFailure('wrong_password', email, agent.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    // The password is right; the phone must be the one linked to this account. Checked
    // before any two-factor code goes out, so a refused device never gets one.
    await this.deviceBinding?.assertSignInDevice('AGENT', agent.id, meta?.device);

    await this.prisma.agent.update({ where: { id: agent.id }, data: { hasLoggedIn: true } });

    if (agent.twoFactorEnabled) {
      return this.beginTwoFactorLogin(agent);
    }

    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agent.id,
      action: 'agent.login.succeeded',
      targetType: 'Agent',
      targetId: agent.id,
    });
    return this.issueTokens(agent, meta);
  }

  async getMustChangePasswordForAgent(agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    return agent?.mustChangePassword ?? false;
  }

  async getCanOnboardClientsForAgent(agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    return agent?.canOnboardClients ?? false;
  }

  async changePassword(agentId: string, currentPassword: string, newPassword: string): Promise<{ sent: true; devCode?: string }> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
      await this.auditLogService.recordSafely({
        actorType: AuditActorType.AGENT,
        actorId: agentId,
        action: 'agent.password.change_failed',
        targetType: 'Agent',
        targetId: agentId,
      });
      throw new UnauthorizedException('Current password is incorrect');
    }

    const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    const pendingHash = await hashPassword(newPassword);

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        changePasswordPendingHash: pendingHash,
        changePasswordCodeHash: hashToken(code),
        changePasswordCodeExpiresAt: new Date(Date.now() + CHANGE_PASSWORD_CODE_TTL_MS),
      },
    });

    await this.emailService.send({ to: agent.email, ...changePasswordConfirmationCodeEmail({ code, ttlMinutes: 10 }) });

    return { sent: true, devCode: devCodeEcho(this.configService, code) };
  }

  async confirmChangePassword(agentId: string, code: string): Promise<{ accessToken: string }> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    if (!agent.changePasswordPendingHash) {
      throw new ConflictException('No password change is pending confirmation');
    }

    if (
      !agent.changePasswordCodeHash ||
      !agent.changePasswordCodeExpiresAt ||
      agent.changePasswordCodeExpiresAt < new Date() ||
      agent.changePasswordCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        passwordHash: agent.changePasswordPendingHash,
        mustChangePassword: false,
        changePasswordPendingHash: null,
        changePasswordCodeHash: null,
        changePasswordCodeExpiresAt: null,
      },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: 'agent.password.changed',
      targetType: 'Agent',
      targetId: agentId,
    });

    const payload: JwtPayload = { sub: agentId, type: 'agent', mustChangePassword: false };
    return { accessToken: this.tokenService.signAccessToken(payload) };
  }

  async resendChangePasswordCode(agentId: string): Promise<{ sent: true; devCode?: string }> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    if (!agent.changePasswordPendingHash) {
      throw new ConflictException('No password change is pending confirmation');
    }

    const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        changePasswordCodeHash: hashToken(code),
        changePasswordCodeExpiresAt: new Date(Date.now() + CHANGE_PASSWORD_CODE_TTL_MS),
      },
    });

    await this.emailService.send({ to: agent.email, ...changePasswordConfirmationCodeEmail({ code, ttlMinutes: 10 }) });

    return { sent: true, devCode: devCodeEcho(this.configService, code) };
  }

  async forgotPassword(email: string): Promise<{ devCode?: string }> {
    const agent = await this.prisma.agent.findUnique({ where: { email } });
    if (!agent || agent.status !== AgentStatus.APPROVED) {
      return {};
    }

    const token = generateOpaqueToken();
    const codeLength = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(codeLength);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordResetTokenHash: hashToken(token),
        passwordResetTokenExpiresAt: expiresAt,
        passwordResetCodeHash: hashToken(code),
        passwordResetCodeExpiresAt: expiresAt,
      },
    });

    await this.emailService.send({ to: agent.email, ...agentPasswordResetEmail({ token, code }) });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agent.id,
      action: 'agent.password.reset_requested',
      targetType: 'Agent',
      targetId: agent.id,
    });

    return { devCode: devCodeEcho(this.configService, code) };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findFirst({
      where: { passwordResetTokenHash: hashToken(token) },
    });

    if (!agent || !agent.passwordResetTokenExpiresAt || agent.passwordResetTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
        passwordResetCodeHash: null,
        passwordResetCodeExpiresAt: null,
      },
    });

    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, agent.id, 'password_reset');
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agent.id,
      action: 'agent.password.reset',
      targetType: 'Agent',
      targetId: agent.id,
    });
  }

  async resetPasswordByCode(email: string, code: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (
      !agent ||
      !agent.passwordResetCodeHash ||
      !agent.passwordResetCodeExpiresAt ||
      agent.passwordResetCodeExpiresAt < new Date() ||
      agent.passwordResetCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired reset code');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
        passwordResetCodeHash: null,
        passwordResetCodeExpiresAt: null,
      },
    });

    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, agent.id, 'password_reset');
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agent.id,
      action: 'agent.password.reset',
      targetType: 'Agent',
      targetId: agent.id,
    });
  }

  async setupTwoFactor(agentId: string, method: TwoFactorMethod) {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    if (agent.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is already enabled');
    }

    if (method === TwoFactorMethod.TOTP) {
      const secret = generateSecret();
      await this.prisma.agent.update({
        where: { id: agentId },
        data: { twoFactorPendingMethod: TwoFactorMethod.TOTP, twoFactorPendingSecret: secret },
      });
      const otpauthUrl = generateURI({ issuer: 'Public Sector Backend', label: agent.email, secret });
      return { method: TwoFactorMethod.TOTP, secret, otpauthUrl };
    }

    const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        twoFactorPendingMethod: TwoFactorMethod.EMAIL,
        twoFactorEmailCodeHash: hashToken(code),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
      },
    });
    await this.emailService.send({ to: agent.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
    return { method: TwoFactorMethod.EMAIL, devCode: devCodeEcho(this.configService, code) };
  }

  async confirmTwoFactor(agentId: string, code: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    if (!agent.twoFactorPendingMethod) {
      throw new ConflictException('No two-factor setup in progress');
    }

    if (agent.twoFactorPendingMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: agent.twoFactorPendingSecret!, token: code });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid verification code');
      }

      await this.prisma.agent.update({
        where: { id: agentId },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: TwoFactorMethod.TOTP,
          twoFactorSecret: agent.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
        },
      });
      await this.auditLogService.recordSafely({
        actorType: AuditActorType.AGENT,
        actorId: agentId,
        action: 'agent.2fa.enabled',
        targetType: 'Agent',
        targetId: agentId,
        metadata: { method: TwoFactorMethod.TOTP },
      });
      return;
    }

    if (
      !agent.twoFactorEmailCodeHash ||
      !agent.twoFactorEmailCodeExpiresAt ||
      agent.twoFactorEmailCodeExpiresAt < new Date() ||
      agent.twoFactorEmailCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: TwoFactorMethod.EMAIL,
        twoFactorPendingMethod: null,
        twoFactorEmailCodeHash: null,
        twoFactorEmailCodeExpiresAt: null,
      },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: 'agent.2fa.enabled',
      targetType: 'Agent',
      targetId: agentId,
      metadata: { method: TwoFactorMethod.EMAIL },
    });
  }

  async disableTwoFactor(agentId: string, currentPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
      await this.auditLogService.recordSafely({
        actorType: AuditActorType.AGENT,
        actorId: agentId,
        action: 'agent.password.change_failed',
        targetType: 'Agent',
        targetId: agentId,
      });
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (!agent.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is not enabled');
    }

    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        twoFactorEnabled: false,
        twoFactorMethod: null,
        twoFactorSecret: null,
        twoFactorPendingSecret: null,
        twoFactorPendingMethod: null,
        twoFactorEmailCodeHash: null,
        twoFactorEmailCodeExpiresAt: null,
      },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agentId,
      action: 'agent.2fa.disabled',
      targetType: 'Agent',
      targetId: agentId,
    });
  }

  private async beginTwoFactorLogin(agent: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    let devCode: string | undefined;
    if (agent.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
      const code = generateNumericCode(length);
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({ to: agent.email, ...loginVerificationCodeEmail({ code, ttlMinutes: 10 }) });
      devCode = devCodeEcho(this.configService, code);
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(agent.id);
    return { twoFactorRequired: true, method: agent.twoFactorMethod, pendingToken, devCode };
  }

  async verifyTwoFactorLogin(pendingToken: string, code: string, meta?: SignInMetadata) {
    let payload: { sub: string };
    try {
      payload = this.tokenService.verifyTwoFactorPendingToken(pendingToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired pending token');
    }

    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: payload.sub } });

    if (agent.twoFactorMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: agent.twoFactorSecret!, token: code });
      if (!result.valid) {
        await this.recordLoginFailure('wrong_2fa_code', agent.email, agent.id);
        throw new UnauthorizedException('Invalid verification code');
      }
    } else {
      if (
        !agent.twoFactorEmailCodeHash ||
        !agent.twoFactorEmailCodeExpiresAt ||
        agent.twoFactorEmailCodeExpiresAt < new Date() ||
        agent.twoFactorEmailCodeHash !== hashToken(code)
      ) {
        await this.recordLoginFailure('wrong_2fa_code', agent.email, agent.id);
        throw new UnauthorizedException('Invalid verification code');
      }
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    }

    await this.auditLogService.recordSafely({
      actorType: AuditActorType.AGENT,
      actorId: agent.id,
      action: 'agent.login.succeeded',
      targetType: 'Agent',
      targetId: agent.id,
      metadata: { twoFactor: true },
    });
    return this.issueTokens(agent, meta);
  }

  private async issueTokens(
    agent: { id: string; mustChangePassword: boolean; canOnboardClients: boolean },
    meta?: SignInMetadata,
  ) {
    // Binds the device on first sign-in, refuses another one.
    const device = await this.deviceBinding?.assertSignInDevice('AGENT', agent.id, meta?.device);
    const payload = {
      sub: agent.id,
      type: 'agent' as const,
      mustChangePassword: agent.mustChangePassword,
      canOnboardClients: agent.canOnboardClients,
    };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.AGENT,
      principalId: agent.id,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
      deviceId: device?.id,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}

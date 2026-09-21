import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { generateSecret, generateURI, verify } from 'otplib';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AgentStatus, SessionPrincipalType, TwoFactorMethod } from '../../generated/prisma/client';
import { hashPassword } from '../../common/password-hash.util';
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { generateEmailCode } from '../../common/generate-email-code.util';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AgentAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly emailService: EmailService,
  ) {}

  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const agent = await this.prisma.agent.findUnique({ where: { email } });

    if (!agent || agent.status !== 'APPROVED' || !agent.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, agent.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.agent.update({ where: { id: agent.id }, data: { hasLoggedIn: true } });

    if (agent.twoFactorEnabled) {
      return this.beginTwoFactorLogin(agent);
    }

    return this.issueTokens(agent, meta);
  }

  async getMustChangePasswordForAgent(agentId: string): Promise<boolean> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    return agent?.mustChangePassword ?? false;
  }

  async changePassword(agentId: string, currentPassword: string, newPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.agent.update({
      where: { id: agentId },
      data: { passwordHash, mustChangePassword: false },
    });
  }

  async forgotPassword(email: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { email } });
    if (!agent || agent.status !== AgentStatus.APPROVED) {
      return;
    }

    const token = generateOpaqueToken();
    await this.prisma.agent.update({
      where: { id: agent.id },
      data: {
        passwordResetTokenHash: hashToken(token),
        passwordResetTokenExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    await this.emailService.send({
      to: agent.email,
      subject: 'Reset your password',
      html: `<p>Use this token to reset your password: ${token}</p>`,
      text: `Use this token to reset your password: ${token}`,
    });
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
      },
    });

    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.AGENT, agent.id, 'password_reset');
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

    const code = generateEmailCode();
    await this.prisma.agent.update({
      where: { id: agentId },
      data: {
        twoFactorPendingMethod: TwoFactorMethod.EMAIL,
        twoFactorEmailCodeHash: hashToken(code),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
      },
    });
    await this.emailService.send({
      to: agent.email,
      subject: 'Your two-factor setup code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
    return { method: TwoFactorMethod.EMAIL };
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
  }

  async disableTwoFactor(agentId: string, currentPassword: string): Promise<void> {
    const agent = await this.prisma.agent.findUniqueOrThrow({ where: { id: agentId } });

    const passwordMatches = await bcrypt.compare(currentPassword, agent.passwordHash!);
    if (!passwordMatches) {
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
  }

  private async beginTwoFactorLogin(agent: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    if (agent.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const code = generateEmailCode();
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({
        to: agent.email,
        subject: 'Your login verification code',
        html: `<p>Your verification code is: ${code}</p>`,
        text: `Your verification code is: ${code}`,
      });
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(agent.id);
    return { twoFactorRequired: true, method: agent.twoFactorMethod, pendingToken };
  }

  async verifyTwoFactorLogin(pendingToken: string, code: string, meta?: { userAgent?: string; ip?: string }) {
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
        throw new UnauthorizedException('Invalid verification code');
      }
    } else {
      if (
        !agent.twoFactorEmailCodeHash ||
        !agent.twoFactorEmailCodeExpiresAt ||
        agent.twoFactorEmailCodeExpiresAt < new Date() ||
        agent.twoFactorEmailCodeHash !== hashToken(code)
      ) {
        throw new UnauthorizedException('Invalid verification code');
      }
      await this.prisma.agent.update({
        where: { id: agent.id },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    }

    return this.issueTokens(agent, meta);
  }

  private async issueTokens(agent: { id: string; mustChangePassword: boolean }, meta?: { userAgent?: string; ip?: string }) {
    const payload = { sub: agent.id, type: 'agent' as const, mustChangePassword: agent.mustChangePassword };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.AGENT,
      principalId: agent.id,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}

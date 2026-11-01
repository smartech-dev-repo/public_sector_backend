import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { generateSecret, generateURI, verify } from 'otplib';
import { AuditLogService } from '../../audit/audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { hashPassword } from '../../common/password-hash.util';
import { ConfigService } from '@nestjs/config';
import { generateNumericCode } from '../../common/generate-numeric-code.util';
import { JwtPayload } from '../jwt-payload.interface';
import { adminPasswordResetEmail } from '../../email/templates/token-emails';
import { twoFactorSetupCodeEmail, loginVerificationCodeEmail } from '../../email/templates/verification-code-emails';
import { devCodeEcho } from '../../common/dev-code-echo.util';
import { SessionPrincipalType, TwoFactorMethod, AuditActorType } from '../../generated/prisma/client';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const TWO_FACTOR_EMAIL_CODE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly adminInviteService: AdminInviteService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly configService?: ConfigService,
  ) {}

  private recordLoginFailure(reason: string, email?: string, adminId?: string) {
    return this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: reason === 'inactive_account' ? 'admin.login.denied' : 'admin.login.failed',
      targetType: adminId ? 'AdminUser' : undefined,
      targetId: adminId,
      metadata: { email, reason },
    });
  }

  async getPermissionsForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });

    if (!admin) {
      return [];
    }

    return admin.role.permissions.map((rp) => rp.permission.key);
  }

  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });

    if (!admin || !admin.isActive) {
      await this.recordLoginFailure(admin ? 'inactive_account' : 'unknown_account', email, admin?.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      await this.recordLoginFailure('wrong_password', email, admin.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (admin.twoFactorEnabled) {
      return this.beginTwoFactorLogin(admin);
    }

    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: admin.id,
      action: 'admin.login.succeeded',
      targetType: 'AdminUser',
      targetId: admin.id,
    });
    return this.issueTokens(admin.id, meta);
  }

  async acceptInvite(
    token: string,
    password: string,
    firstName: string,
    lastName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await hashPassword(password);
    const role = await this.prisma.role.findUniqueOrThrow({ where: { id: invite.roleId } });

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
        roleId: role.id,
        departmentId: role.departmentId,
      },
    });

    await this.adminInviteService.markAccepted(invite.id);

    return this.issueTokens(admin.id, meta);
  }

  async forgotPassword(email: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });
    if (!admin || !admin.isActive) {
      return;
    }

    const token = generateOpaqueToken();
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        passwordResetTokenHash: hashToken(token),
        passwordResetTokenExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    await this.emailService.send({
      to: admin.email,
      ...adminPasswordResetEmail({ token, resetUrl: this.buildResetUrl(token) }),
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: admin.id,
      action: 'admin.password.reset_requested',
      targetType: 'AdminUser',
      targetId: admin.id,
    });
  }

  private buildResetUrl(token: string): string | undefined {
    const dashboardUrl = this.configService?.get<string>('ADMIN_DASHBOARD_URL');
    return dashboardUrl ? `${dashboardUrl}/reset-password?token=${token}` : undefined;
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { passwordResetTokenHash: hashToken(token) },
    });

    if (!admin || !admin.passwordResetTokenExpiresAt || admin.passwordResetTokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    });

    await this.sessionService.revokeAllForPrincipal(SessionPrincipalType.ADMIN, admin.id, 'password_reset');
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: admin.id,
      action: 'admin.password.reset',
      targetType: 'AdminUser',
      targetId: admin.id,
    });
  }

  async changePassword(adminId: string, currentPassword: string, newPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    const passwordMatches = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!passwordMatches) {
      await this.auditLogService.recordSafely({
        actorType: AuditActorType.ADMIN,
        actorId: adminId,
        action: 'admin.password.change_failed',
        targetType: 'AdminUser',
        targetId: adminId,
      });
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'admin.password.changed',
      targetType: 'AdminUser',
      targetId: adminId,
    });
  }

  async setupTwoFactor(adminId: string, method: TwoFactorMethod) {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });
    if (admin.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is already enabled');
    }

    if (method === TwoFactorMethod.TOTP) {
      const secret = generateSecret();
      await this.prisma.adminUser.update({
        where: { id: adminId },
        data: { twoFactorPendingMethod: TwoFactorMethod.TOTP, twoFactorPendingSecret: secret },
      });
      const otpauthUrl = generateURI({ issuer: 'Public Sector Backend', label: admin.email, secret });
      return { method: TwoFactorMethod.TOTP, secret, otpauthUrl };
    }

    const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
    const code = generateNumericCode(length);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        twoFactorPendingMethod: TwoFactorMethod.EMAIL,
        twoFactorEmailCodeHash: hashToken(code),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
      },
    });
    await this.emailService.send({ to: admin.email, ...twoFactorSetupCodeEmail({ code, ttlMinutes: 10 }) });
    return { method: TwoFactorMethod.EMAIL, devCode: devCodeEcho(this.configService, code) };
  }

  async confirmTwoFactor(adminId: string, code: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    if (!admin.twoFactorPendingMethod) {
      throw new ConflictException('No two-factor setup in progress');
    }

    if (admin.twoFactorPendingMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: admin.twoFactorPendingSecret!, token: code });
      if (!result.valid) {
        await this.recordLoginFailure('wrong_2fa_code', admin.email, admin.id);
        throw new UnauthorizedException('Invalid verification code');
      }

      await this.prisma.adminUser.update({
        where: { id: adminId },
        data: {
          twoFactorEnabled: true,
          twoFactorMethod: TwoFactorMethod.TOTP,
          twoFactorSecret: admin.twoFactorPendingSecret,
          twoFactorPendingSecret: null,
          twoFactorPendingMethod: null,
        },
      });
      await this.auditLogService.recordSafely({
        actorType: AuditActorType.ADMIN,
        actorId: adminId,
        action: 'admin.2fa.enabled',
        targetType: 'AdminUser',
        targetId: adminId,
        metadata: { method: TwoFactorMethod.TOTP },
      });
      return;
    }

    if (
      !admin.twoFactorEmailCodeHash ||
      !admin.twoFactorEmailCodeExpiresAt ||
      admin.twoFactorEmailCodeExpiresAt < new Date() ||
      admin.twoFactorEmailCodeHash !== hashToken(code)
    ) {
      throw new UnauthorizedException('Invalid or expired verification code');
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        twoFactorEnabled: true,
        twoFactorMethod: TwoFactorMethod.EMAIL,
        twoFactorPendingMethod: null,
        twoFactorEmailCodeHash: null,
        twoFactorEmailCodeExpiresAt: null,
      },
    });
    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'admin.2fa.enabled',
      targetType: 'AdminUser',
      targetId: adminId,
      metadata: { method: TwoFactorMethod.EMAIL },
    });
  }

  async disableTwoFactor(adminId: string, currentPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    const passwordMatches = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    if (!admin.twoFactorEnabled) {
      throw new ConflictException('Two-factor authentication is not enabled');
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
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
      actorType: AuditActorType.ADMIN,
      actorId: adminId,
      action: 'admin.2fa.disabled',
      targetType: 'AdminUser',
      targetId: adminId,
    });
  }

  private async beginTwoFactorLogin(admin: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    let devCode: string | undefined;
    if (admin.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const length = Number(this.configService?.get('EMAIL_CODE_LENGTH') ?? 6);
      const code = generateNumericCode(length);
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({ to: admin.email, ...loginVerificationCodeEmail({ code, ttlMinutes: 10 }) });
      devCode = devCodeEcho(this.configService, code);
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(admin.id);
    return { twoFactorRequired: true, method: admin.twoFactorMethod, pendingToken, devCode };
  }

  async verifyTwoFactorLogin(pendingToken: string, code: string, meta?: { userAgent?: string; ip?: string }) {
    let payload: { sub: string };
    try {
      payload = this.tokenService.verifyTwoFactorPendingToken(pendingToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired pending token');
    }

    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: payload.sub } });

    if (admin.twoFactorMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: admin.twoFactorSecret!, token: code });
      if (!result.valid) {
        throw new UnauthorizedException('Invalid verification code');
      }
    } else {
      if (
        !admin.twoFactorEmailCodeHash ||
        !admin.twoFactorEmailCodeExpiresAt ||
        admin.twoFactorEmailCodeExpiresAt < new Date() ||
        admin.twoFactorEmailCodeHash !== hashToken(code)
      ) {
        await this.recordLoginFailure('wrong_2fa_code', admin.email, admin.id);
        throw new UnauthorizedException('Invalid verification code');
      }
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    }

    await this.auditLogService.recordSafely({
      actorType: AuditActorType.ADMIN,
      actorId: admin.id,
      action: 'admin.login.succeeded',
      targetType: 'AdminUser',
      targetId: admin.id,
      metadata: { twoFactor: true },
    });
    return this.issueTokens(admin.id, meta);
  }

  private async issueTokens(adminId: string, meta?: { userAgent?: string; ip?: string }) {
    const permissions = await this.getPermissionsForAdmin(adminId);
    const payload: JwtPayload = { sub: adminId, type: 'admin', permissions };

    const refreshToken = await this.sessionService.createSession({
      principalType: SessionPrincipalType.ADMIN,
      principalId: adminId,
      userAgent: meta?.userAgent,
      ip: meta?.ip,
    });

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken,
    };
  }
}

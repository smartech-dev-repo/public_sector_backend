import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { generateSecret, generateURI, verify } from 'otplib';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { hashPassword } from '../../common/password-hash.util';
import { generateEmailCode } from '../../common/generate-email-code.util';
import { JwtPayload } from '../jwt-payload.interface';
import { SessionPrincipalType, TwoFactorMethod } from '../../generated/prisma/client';

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
  ) {}

  async getPermissionsForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: {
        roles: {
          include: {
            role: { include: { permissions: { include: { permission: true } } } },
          },
        },
      },
    });

    if (!admin) {
      return [];
    }

    return Array.from(
      new Set(
        admin.roles.flatMap((adminRole) =>
          adminRole.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    );
  }

  async login(email: string, password: string, meta?: { userAgent?: string; ip?: string }) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email } });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (admin.twoFactorEnabled) {
      return this.beginTwoFactorLogin(admin);
    }

    return this.issueTokens(admin.id, meta);
  }

  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await hashPassword(password);

    const admin = await this.prisma.adminUser.create({
      data: {
        email: invite.email,
        passwordHash,
        fullName,
        roles: { create: { roleId: invite.roleId } },
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
      subject: 'Reset your password',
      html: `<p>Use this token to reset your password: ${token}</p>`,
      text: `Use this token to reset your password: ${token}`,
    });
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
  }

  async changePassword(adminId: string, currentPassword: string, newPassword: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    const passwordMatches = await bcrypt.compare(currentPassword, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await hashPassword(newPassword);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash },
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

    const code = generateEmailCode();
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        twoFactorPendingMethod: TwoFactorMethod.EMAIL,
        twoFactorEmailCodeHash: hashToken(code),
        twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
      },
    });
    await this.emailService.send({
      to: admin.email,
      subject: 'Your two-factor setup code',
      html: `<p>Your verification code is: ${code}</p>`,
      text: `Your verification code is: ${code}`,
    });
    return { method: TwoFactorMethod.EMAIL };
  }

  async confirmTwoFactor(adminId: string, code: string): Promise<void> {
    const admin = await this.prisma.adminUser.findUniqueOrThrow({ where: { id: adminId } });

    if (!admin.twoFactorPendingMethod) {
      throw new ConflictException('No two-factor setup in progress');
    }

    if (admin.twoFactorPendingMethod === TwoFactorMethod.TOTP) {
      const result = await verify({ secret: admin.twoFactorPendingSecret!, token: code });
      if (!result.valid) {
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
  }

  private async beginTwoFactorLogin(admin: { id: string; email: string; twoFactorMethod: TwoFactorMethod | null }) {
    if (admin.twoFactorMethod === TwoFactorMethod.EMAIL) {
      const code = generateEmailCode();
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: {
          twoFactorEmailCodeHash: hashToken(code),
          twoFactorEmailCodeExpiresAt: new Date(Date.now() + TWO_FACTOR_EMAIL_CODE_TTL_MS),
        },
      });
      await this.emailService.send({
        to: admin.email,
        subject: 'Your login verification code',
        html: `<p>Your verification code is: ${code}</p>`,
        text: `Your verification code is: ${code}`,
      });
    }

    const pendingToken = this.tokenService.signTwoFactorPendingToken(admin.id);
    return { twoFactorRequired: true, method: admin.twoFactorMethod, pendingToken };
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
        throw new UnauthorizedException('Invalid verification code');
      }
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { twoFactorEmailCodeHash: null, twoFactorEmailCodeExpiresAt: null },
      });
    }

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

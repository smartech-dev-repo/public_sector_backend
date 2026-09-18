import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { SessionService } from '../../session/session.service';
import { AdminInviteService } from '../../admin-invite/admin-invite.service';
import { EmailService } from '../../email/email.service';
import { generateOpaqueToken, hashToken } from '../../common/opaque-token.util';
import { JwtPayload } from '../jwt-payload.interface';
import { SessionPrincipalType } from '../../generated/prisma/client';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

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

    return this.issueTokens(admin.id, meta);
  }

  async acceptInvite(
    token: string,
    password: string,
    fullName: string,
    meta?: { userAgent?: string; ip?: string },
  ) {
    const invite = await this.adminInviteService.findValidByToken(token);
    const passwordHash = await bcrypt.hash(password, 12);

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

    const passwordHash = await bcrypt.hash(newPassword, 12);
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

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { passwordHash },
    });
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

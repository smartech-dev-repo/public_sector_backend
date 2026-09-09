import { Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  async login(email: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { email },
      include: {
        roles: {
          include: {
            role: { include: { permissions: { include: { permission: true } } } },
          },
        },
      },
    });

    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordMatches = await bcrypt.compare(password, admin.passwordHash);
    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const permissions = Array.from(
      new Set(
        admin.roles.flatMap((adminRole) =>
          adminRole.role.permissions.map((rp) => rp.permission.key),
        ),
      ),
    );

    const payload = { sub: admin.id, type: 'admin' as const, permissions };

    return {
      accessToken: this.tokenService.signAccessToken(payload),
      refreshToken: this.tokenService.signRefreshToken(payload),
    };
  }
}

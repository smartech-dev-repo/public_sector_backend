import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashToken } from '../common/opaque-token.util';
import { AdminInvite, AdminInviteStatus } from '../generated/prisma/client';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CreateInviteParams {
  email: string;
  roleId: string;
  invitedById: string;
}

export interface IssuedInvite {
  invite: AdminInvite;
  token: string;
}

@Injectable()
export class AdminInviteService {
  constructor(private readonly prisma: PrismaService) {}

  async create(params: CreateInviteParams): Promise<IssuedInvite> {
    const token = generateOpaqueToken();

    const invite = await this.prisma.adminInvite.create({
      data: {
        email: params.email,
        roleId: params.roleId,
        invitedById: params.invitedById,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });

    return { invite, token };
  }

  async resend(id: string): Promise<IssuedInvite> {
    const existing = await this.prisma.adminInvite.findUnique({ where: { id } });

    if (!existing || existing.status !== AdminInviteStatus.PENDING) {
      throw new NotFoundException('Invite not found or not pending');
    }

    const token = generateOpaqueToken();

    const invite = await this.prisma.adminInvite.update({
      where: { id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });

    return { invite, token };
  }

  async list(status?: AdminInviteStatus): Promise<AdminInvite[]> {
    return this.prisma.adminInvite.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findValidByToken(token: string): Promise<AdminInvite> {
    const invite = await this.prisma.adminInvite.findUnique({
      where: { tokenHash: hashToken(token) },
    });

    if (!invite || invite.status !== AdminInviteStatus.PENDING || invite.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired invitation');
    }

    return invite;
  }

  async markAccepted(id: string): Promise<void> {
    await this.prisma.adminInvite.update({
      where: { id },
      data: { status: AdminInviteStatus.ACCEPTED, acceptedAt: new Date() },
    });
  }
}

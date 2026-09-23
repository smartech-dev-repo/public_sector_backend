import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateOpaqueToken, hashToken } from '../common/opaque-token.util';
import { AdminInvite, AdminInviteStatus, Prisma } from '../generated/prisma/client';
import { buildPaginatedResult, PaginatedResult } from '../common/pagination/paginated-result';

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

export interface ListInvitesFilters {
  status?: AdminInviteStatus;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  expiresFrom?: Date;
  expiresTo?: Date;
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

  async list(
    filters: ListInvitesFilters = {},
    pagination: { page: number; limit: number } = { page: 1, limit: 25 },
  ): Promise<PaginatedResult<AdminInvite>> {
    const { page, limit } = pagination;
    const where: Prisma.AdminInviteWhereInput = {
      status: filters.status,
      createdAt:
        filters.createdFrom || filters.createdTo
          ? { gte: filters.createdFrom, lte: filters.createdTo }
          : undefined,
      expiresAt:
        filters.expiresFrom || filters.expiresTo
          ? { gte: filters.expiresFrom, lte: filters.expiresTo }
          : undefined,
      email: filters.q ? { contains: filters.q, mode: 'insensitive' } : undefined,
    };

    const [data, total] = await Promise.all([
      this.prisma.adminInvite.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.adminInvite.count({ where }),
    ]);

    return buildPaginatedResult(data, total, page, limit);
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

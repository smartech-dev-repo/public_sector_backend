import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ClientInScope } from '../auth/client-scope.guard';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { auditChanges } from '../audit/audit-changes.util';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RepaymentCapacityDto } from './dto/repayment-capacity.dto';
import { capacityChange } from './repayment-capacity.util';

const CAPACITY_SELECT = {
  id: true,
  affordabilityMethod: true,
  basePayAmount: true,
  dtiPercent: true,
} as const;
const CAPACITY_FIELDS = [
  'affordabilityMethod',
  'basePayAmount',
  'dtiPercent',
] as const;

/**
 * Repayment capacity for a sector or a single client. A client's setting beats their
 * sector's, which beats the default under Loan Settings.
 */
@Controller('admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('loan-settings:manage')
export class AdminRepaymentCapacityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private record(
    req: { user: JwtPayload },
    targetType: string,
    targetId: string,
    changes: object,
  ) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'repayment-capacity.updated',
      targetType,
      targetId,
      metadata: { changes } as Prisma.InputJsonObject,
    });
  }

  @Patch('sectors/:id/repayment-capacity')
  @HttpCode(200)
  async updateSector(
    @Param('id') id: string,
    @Body() dto: RepaymentCapacityDto,
    @Req() req: { user: JwtPayload },
  ) {
    const before = await this.prisma.sector.findUnique({
      where: { id },
      select: CAPACITY_SELECT,
    });
    if (!before) throw new NotFoundException('Sector not found');
    const after = await this.prisma.sector.update({
      where: { id },
      data: capacityChange(dto, before),
      select: { ...CAPACITY_SELECT, code: true, name: true },
    });
    await this.record(
      req,
      'Sector',
      id,
      auditChanges(before, after, [...CAPACITY_FIELDS]),
    );
    return after;
  }

  @Get('clients/:clientId/repayment-capacity')
  @ClientInScope('clientId')
  async getClient(@Param('clientId') clientId: string) {
    const client = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: CAPACITY_SELECT,
    });
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }

  @Patch('clients/:clientId/repayment-capacity')
  @ClientInScope('clientId')
  @HttpCode(200)
  async updateClient(
    @Param('clientId') clientId: string,
    @Body() dto: RepaymentCapacityDto,
    @Req() req: { user: JwtPayload },
  ) {
    const before = await this.prisma.client.findUnique({
      where: { id: clientId },
      select: CAPACITY_SELECT,
    });
    if (!before) throw new NotFoundException('Client not found');
    const after = await this.prisma.client.update({
      where: { id: clientId },
      data: capacityChange(dto, before),
      select: CAPACITY_SELECT,
    });
    await this.record(
      req,
      'Client',
      clientId,
      auditChanges(before, after, [...CAPACITY_FIELDS]),
    );
    return after;
  }
}

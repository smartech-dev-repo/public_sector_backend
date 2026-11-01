import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { auditChanges } from '../audit/audit-changes.util';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { ManagementFeesService } from './management-fees.service';
import { CreateManagementFeeDto } from './dto/create-management-fee.dto';
import { UpdateManagementFeeDto } from './dto/update-management-fee.dto';
import { ListManagementFeesQueryDto } from './dto/list-management-fees-query.dto';

const AUDITED_FEE_FIELDS = ['name', 'type', 'value', 'minAmount', 'maxAmount', 'isActive'] as const;

@Controller('admin/management-fees')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('management-fees:manage')
export class AdminManagementFeesController {
  constructor(
    private readonly managementFeesService: ManagementFeesService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private recordFeeEvent(req: { user: JwtPayload }, action: string, id: string, metadata: Prisma.InputJsonObject) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action,
      targetType: 'ManagementFee',
      targetId: id,
      metadata,
    });
  }

  @Post()
  async create(@Body() dto: CreateManagementFeeDto, @Req() req: { user: JwtPayload }) {
    const fee = await this.managementFeesService.create(dto);
    await this.recordFeeEvent(req, 'management-fee.created', fee.id, { name: fee.name, type: fee.type, value: String(fee.value) });
    return fee;
  }

  @Get()
  list(@Query() query: ListManagementFeesQueryDto) {
    return this.managementFeesService.list({ q: query.q, isActive: query.isActive }, { page: query.page, limit: query.limit });
  }

  @Patch(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() dto: UpdateManagementFeeDto, @Req() req: { user: JwtPayload }) {
    const before = await this.managementFeesService.findById(id);
    const fee = await this.managementFeesService.update(id, dto);
    await this.recordFeeEvent(req, 'management-fee.updated', id, {
      changes: auditChanges(before, fee, [...AUDITED_FEE_FIELDS]),
    } as Prisma.InputJsonObject);
    return fee;
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const before = await this.managementFeesService.findById(id);
    await this.managementFeesService.remove(id);
    await this.recordFeeEvent(req, 'management-fee.deleted', id, { name: before.name, type: before.type, value: String(before.value) });
    return { deleted: true };
  }
}

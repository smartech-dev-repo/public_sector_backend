import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { auditChanges } from '../audit/audit-changes.util';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { CreateSectorDto } from './dto/create-sector.dto';
import { UpdateSectorDto } from './dto/update-sector.dto';
import { SectorService } from './sector.service';

@Controller('admin/sectors')
@UseGuards(JwtAuthGuard, AdminOnlyGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminSectorsController {
  constructor(
    private readonly sectorService: SectorService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private recordEvent(req: { user: JwtPayload }, action: string, id: string, metadata: Prisma.InputJsonObject) {
    return this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action,
      targetType: 'Sector',
      targetId: id,
      metadata,
    });
  }

  // Open to every admin: filters and pickers across the app read this list.
  @Get()
  list() {
    return this.sectorService.list();
  }

  @Post()
  @RequirePermissions('sectors:manage')
  async create(@Body() dto: CreateSectorDto, @Req() req: { user: JwtPayload }) {
    const sector = await this.sectorService.create(dto);
    await this.recordEvent(req, 'sector.created', sector.id, { code: sector.code });
    return sector;
  }

  @Patch(':id')
  @RequirePermissions('sectors:manage')
  async update(@Param('id') id: string, @Body() dto: UpdateSectorDto, @Req() req: { user: JwtPayload }) {
    const { before, after } = await this.sectorService.updateName(id, dto.name);
    await this.recordEvent(req, 'sector.updated', id, {
      code: after.code,
      changes: auditChanges(before, after, ['name']),
    } as Prisma.InputJsonObject);
    return after;
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('sectors:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    const sector = await this.sectorService.remove(id);
    await this.recordEvent(req, 'sector.deleted', id, { code: sector.code });
    return { deleted: true };
  }
}

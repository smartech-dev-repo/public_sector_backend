import { Body, Controller, Get, HttpCode, Post, Query, Req, StreamableFile, UseGuards, UseInterceptors } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditLogService, ListAuditEventsFilters } from '../audit/audit-log.service';
import { AuditContextInterceptor } from '../audit/audit-context.interceptor';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { ReportDataAccessDto } from './dto/report-data-access.dto';
import { AuditActorType, Prisma } from '../generated/prisma/client';

const MAX_EXPORT_ROWS = 50000;

const EXPORT_COLUMNS = [
  { header: 'When (UTC)', key: 'when', width: 24 },
  { header: 'Who', key: 'who', width: 28 },
  { header: 'Who type', key: 'whoType', width: 10 },
  { header: 'Person ID', key: 'personId', width: 38 },
  { header: 'Action', key: 'action', width: 34 },
  { header: 'Record type', key: 'recordType', width: 20 },
  { header: 'Record', key: 'record', width: 28 },
  { header: 'Record ID', key: 'recordId', width: 38 },
  { header: 'IP address', key: 'ip', width: 18 },
  { header: 'Device', key: 'device', width: 40 },
  { header: 'Details', key: 'details', width: 60 },
];

type Principal = { fullName?: string; email?: string; name?: string; phone?: string; productName?: string; originalFileName?: string; key?: string } | null;

const principalLabel = (principal: Principal) =>
  principal?.fullName ?? principal?.name ?? principal?.productName ?? principal?.originalFileName ?? principal?.key ?? principal?.email ?? principal?.phone ?? '';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditContextInterceptor)
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  private filtersFrom(query: ListAuditLogsQueryDto): ListAuditEventsFilters {
    return {
      actorType: query.actorType,
      actorId: query.actorId,
      action: query.action,
      kind: query.kind,
      targetType: query.targetType,
      targetId: query.targetId,
      createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
      createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
    };
  }

  @Get()
  @RequirePermissions('audit:read')
  list(@Query() query: ListAuditLogsQueryDto) {
    return this.auditLogService.list(this.filtersFrom(query), { page: query.page, limit: query.limit });
  }

  @Get('export')
  @RequirePermissions('audit:read')
  async export(@Query() query: ListAuditLogsQueryDto, @Req() req: { user: JwtPayload }) {
    const filters = this.filtersFrom(query);
    const { rows, total } = await this.auditLogService.listForExport(filters, MAX_EXPORT_ROWS);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Audit trail');
    sheet.columns = EXPORT_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of rows) {
      sheet.addRow({
        when: row.createdAt.toISOString(),
        who: principalLabel(row.actor as Principal),
        whoType: row.actorType,
        personId: row.actorId ?? '',
        action: row.action,
        recordType: row.targetType ?? '',
        record: principalLabel(row.target as Principal),
        recordId: row.targetId ?? '',
        ip: row.ip ?? '',
        device: row.userAgent ?? '',
        details: row.metadata ? JSON.stringify(row.metadata) : '',
      });
    }
    if (total > rows.length) {
      workbook.addWorksheet('Note').addRow([`Showing the newest ${rows.length} of ${total} matching entries. Narrow the date range to see older ones.`]);
    }

    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'audit.exported',
      metadata: { rowCount: rows.length, matched: total, filters: JSON.parse(JSON.stringify(query)) as Prisma.InputJsonObject },
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return new StreamableFile(Buffer.from(buffer), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="audit-trail-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    });
  }

  // Revealing a masked value and spreadsheet exports happen in the browser, so the
  // screen reports them here. It says only what was accessed, never the value.
  @Post('data-access')
  @HttpCode(200)
  @UseGuards(AdminOnlyGuard)
  async reportDataAccess(@Body() dto: ReportDataAccessDto, @Req() req: { user: JwtPayload }) {
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: dto.kind === 'reveal' ? 'data.revealed' : 'data.exported',
      targetType: dto.targetType,
      targetId: dto.targetId,
      metadata: { resource: dto.resource, recordCount: dto.recordCount ?? null },
    });
    return { recorded: true };
  }
}

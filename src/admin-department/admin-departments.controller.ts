import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditLogService } from '../audit/audit-log.service';
import { DepartmentService } from './department.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { ListDepartmentsQueryDto } from './dto/list-departments-query.dto';
import { AuditActorType } from '../generated/prisma/client';

@Controller('admin/departments')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
export class AdminDepartmentsController {
  constructor(
    private readonly departmentService: DepartmentService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Post()
  @RequirePermissions('departments:manage')
  async create(@Body() dto: CreateDepartmentDto, @Req() req: { user: JwtPayload }) {
    const department = await this.departmentService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'department.created',
      targetType: 'Department',
      targetId: department.id,
      metadata: { name: department.name },
    });
    return department;
  }

  @Get()
  @RequirePermissions('departments:manage')
  list(@Query() query: ListDepartmentsQueryDto) {
    return this.departmentService.list({ q: query.q }, { page: query.page, limit: query.limit });
  }

  @Get(':id')
  @RequirePermissions('departments:manage')
  findOne(@Param('id') id: string) {
    return this.departmentService.findById(id);
  }

  @Patch(':id')
  @RequirePermissions('departments:manage')
  update(@Param('id') id: string, @Body() dto: UpdateDepartmentDto) {
    return this.departmentService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('departments:manage')
  async remove(@Param('id') id: string, @Req() req: { user: JwtPayload }) {
    await this.departmentService.remove(id);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'department.deleted',
      targetType: 'Department',
      targetId: id,
    });
    return { deleted: true };
  }
}

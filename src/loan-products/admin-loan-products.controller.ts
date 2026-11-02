import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { auditChanges } from '../audit/audit-changes.util';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditActorType, Prisma } from '../generated/prisma/client';
import { LoanProductsService } from './loan-products.service';
import { CreateLoanProductDto } from './dto/create-loan-product.dto';
import { UpdateLoanProductDto } from './dto/update-loan-product.dto';
import { ListAdminLoanProductsQueryDto } from './dto/list-admin-loan-products-query.dto';
import { SectorService } from '../sectors/sector.service';
import { ManagementFeesService } from '../management-fees/management-fees.service';

const AUDITED_PRODUCT_FIELDS = [
  'productName',
  'productCode',
  'sectors',
  'minimumAmount',
  'maximumAmount',
  'minimumTenorMonths',
  'maximumTenorMonths',
  'interestTiers',
  'managementFeeId',
  'managementChargeType',
  'managementChargeValue',
  'minimumServiceMonthsLeft',
  'maximumMonthsInService',
  'isActive',
] as const;

@Controller('admin/loan-products')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor)
@RequirePermissions('loan-products:manage')
export class AdminLoanProductsController {
  constructor(
    private readonly loanProductsService: LoanProductsService,
    private readonly managementFeesService: ManagementFeesService,
    private readonly auditLogService: AuditLogService,
    private readonly sectorService: SectorService,
  ) {}

  @Get('sectors')
  async sectors() {
    return { sectors: await this.sectorService.codes() };
  }

  @Get('management-fees')
  managementFees() {
    return this.managementFeesService.listActive();
  }

  @Post()
  async create(@Body() dto: CreateLoanProductDto, @Req() req: { user: JwtPayload }) {
    const product = await this.loanProductsService.create(dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-product.created',
      targetType: 'LoanProduct',
      targetId: product.id,
      metadata: { productName: product.productName, productCode: product.productCode },
    });
    return product;
  }

  @Get()
  list(@Query() query: ListAdminLoanProductsQueryDto) {
    return this.loanProductsService.list(
      { sectors: query.sectors, isActive: query.isActive },
      { page: query.page, limit: query.limit },
    );
  }

  @Patch(':id')
  @HttpCode(200)
  async update(@Param('id') id: string, @Body() dto: UpdateLoanProductDto, @Req() req: { user: JwtPayload }) {
    const before = await this.loanProductsService.findById(id);
    const product = await this.loanProductsService.update(id, dto);
    await this.auditLogService.record({
      actorType: AuditActorType.ADMIN,
      actorId: req.user.sub,
      action: 'loan-product.updated',
      targetType: 'LoanProduct',
      targetId: id,
      metadata: { changes: auditChanges(before, product, [...AUDITED_PRODUCT_FIELDS]) } as Prisma.InputJsonObject,
    });
    return product;
  }
}

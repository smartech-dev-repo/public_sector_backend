import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DeductionResolutionService } from './deduction-resolution.service';
import { AssignDeductionDto, DismissDeductionDto, ListDeductionsQueryDto, RefundDeductionDto } from './dto/deduction.dto';

/** Payroll deductions from the repayment schedule, and resolving those that match no running loan. */
@Controller('admin/reconciliation/deductions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminDeductionsController {
  constructor(private readonly deductions: DeductionResolutionService) {}

  @Get()
  @RequirePermissions('reconciliation:read')
  list(@Query() query: ListDeductionsQueryDto) {
    return this.deductions.list(
      {
        view: query.view,
        matchStatus: query.matchStatus,
        resolution: query.resolution,
        agency: query.agency,
        period: query.period,
        search: query.search,
      },
      { page: query.page, limit: query.limit },
    );
  }

  @Get(':id/candidates')
  @RequirePermissions('reconciliation:read')
  candidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.deductions.candidates(id);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @RequirePermissions('reconciliation:resolve')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDeductionDto, @Req() req: { user: JwtPayload }) {
    return this.deductions.assign(id, dto, req.user.sub);
  }

  @Post(':id/refund')
  @HttpCode(200)
  @RequirePermissions('reconciliation:resolve')
  refund(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RefundDeductionDto, @Req() req: { user: JwtPayload }) {
    return this.deductions.requestRefund(id, dto.note, req.user.sub);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @RequirePermissions('reconciliation:resolve')
  dismiss(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DismissDeductionDto, @Req() req: { user: JwtPayload }) {
    return this.deductions.dismiss(id, dto.note, req.user.sub);
  }
}

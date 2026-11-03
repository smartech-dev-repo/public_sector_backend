import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { ClientInScope } from '../auth/client-scope.guard';
import { AffordabilityService } from './eligibility/affordability/affordability.service';
import { LoanEligibilityQueryDto } from './dto/loan-eligibility-query.dto';

@Controller('admin/clients/:clientId/loan-eligibility')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('clients:read')
export class AdminLoanEligibilityController {
  constructor(private readonly affordabilityService: AffordabilityService) {}

  /** The most this client can borrow or top up over a tenor, with the workings. */
  @Get()
  @ClientInScope('clientId')
  preview(
    @Param('clientId') clientId: string,
    @Query() query: LoanEligibilityQueryDto,
  ) {
    return this.affordabilityService.preview(
      clientId,
      query.tenorMonths,
      query.type,
    );
  }
}

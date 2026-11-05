import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { DeviceReleaseService } from './device-release.service';
import {
  ListDevicesQueryDto,
  ListReleaseRequestsQueryDto,
  ReleaseDeviceDto,
} from './dto/device.dto';
import { ProofUpload } from './proof-upload.interceptor';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminOnlyGuard, PermissionsGuard)
@RequirePermissions('devices:read')
export class AdminDevicesController {
  constructor(
    private readonly releases: DeviceReleaseService,
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  @Get('devices')
  list(@Query() query: ListDevicesQueryDto) {
    const { page = 1, limit = 25, ...filters } = query;
    return this.releases.listDevices(filters, { page, limit });
  }

  @Get('device-release-requests')
  requests(@Query() query: ListReleaseRequestsQueryDto) {
    return this.releases.listRequests(query.status, {
      page: query.page ?? 1,
      limit: query.limit ?? 25,
    });
  }

  @Get('devices/:id/proof')
  deviceProof(@Param('id') id: string) {
    return this.releases.proofUrl('device', id);
  }

  @Get('device-release-requests/:id/proof')
  requestProof(@Param('id') id: string) {
    return this.releases.proofUrl('request', id);
  }

  /** Remove a bound device. Needs a reason; attach proof as multipart field "proof". */
  @Post('devices/:id/release')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  @UseInterceptors(ProofUpload())
  release(
    @Param('id') id: string,
    @Body() dto: ReleaseDeviceDto,
    @UploadedFile() proof: Express.Multer.File | undefined,
    @Req() req: { user: JwtPayload },
  ) {
    return this.releases.releaseDevice(id, req.user.sub, dto.reason, proof);
  }

  @Post('device-release-requests/:id/approve')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  @UseInterceptors(ProofUpload())
  approve(
    @Param('id') id: string,
    @Body() dto: ReleaseDeviceDto,
    @UploadedFile() proof: Express.Multer.File | undefined,
    @Req() req: { user: JwtPayload },
  ) {
    return this.releases.approveRequest(id, req.user.sub, dto.reason, proof);
  }

  @Post('device-release-requests/:id/reject')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  reject(
    @Param('id') id: string,
    @Body() dto: ReleaseDeviceDto,
    @Req() req: { user: JwtPayload },
  ) {
    return this.releases.rejectRequest(id, req.user.sub, dto.reason);
  }

  /** Sends a test notification to a bound device, to check push works end to end. */
  @Post('devices/:id/test-push')
  @HttpCode(200)
  @RequirePermissions('devices:manage')
  async testPush(@Param('id') id: string) {
    const device = await this.prisma.device.findUnique({ where: { id } });
    if (!device || device.status !== 'ACTIVE')
      throw new NotFoundException('No active device with this id');
    if (!device.pushToken) return { result: 'no-push-token' };
    return {
      result: await this.push.sendToDevice(device.id, device.pushToken, {
        title: 'Test notification',
        body: 'Push notifications are working on this device.',
        data: { type: 'TEST' },
      }),
    };
  }
}

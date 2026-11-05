import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { DeviceBindingService } from './device-binding.service';
import { DeviceReleaseService } from './device-release.service';
import {
  DeviceReleaseRequestDto,
  PushTokenDto,
  RefusedDeviceReleaseRequestDto,
} from './dto/device.dto';
import { deviceInfoFromHeaders } from './device-info.util';

/** Filed from the device a sign-in was refused on; no session needed, only the refusal's token. */
@Controller('auth/devices')
export class DeviceReleaseRequestController {
  constructor(private readonly releases: DeviceReleaseService) {}

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('release-request')
  @HttpCode(201)
  request(@Body() dto: RefusedDeviceReleaseRequestDto) {
    return this.releases.requestFromRefusedDevice(dto.releaseToken, dto.reason);
  }
}

type Req_ = Request & { user: JwtPayload };

@Controller('agent/devices/me')
@UseGuards(JwtAuthGuard, AgentOnlyGuard)
export class AgentDeviceController {
  constructor(
    private readonly binding: DeviceBindingService,
    private readonly releases: DeviceReleaseService,
  ) {}

  /** The device this account is linked to, and any open release request. */
  @Get()
  me(@Req() req: Req_) {
    return this.binding.summaryFor('AGENT', req.user.sub);
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('release-request')
  release(@Body() dto: DeviceReleaseRequestDto, @Req() req: Req_) {
    return this.releases.requestFromSignedIn('AGENT', req.user.sub, dto.reason);
  }

  @Put('push-token')
  pushToken(@Body() dto: PushTokenDto, @Req() req: Req_) {
    return this.binding.updatePushToken(
      'AGENT',
      req.user.sub,
      deviceInfoFromHeaders(req.headers)?.fingerprint,
      dto.pushToken,
    );
  }
}

@Controller('client/devices/me')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientDeviceController {
  constructor(
    private readonly binding: DeviceBindingService,
    private readonly releases: DeviceReleaseService,
  ) {}

  @Get()
  me(@Req() req: Req_) {
    return this.binding.summaryFor('CLIENT', req.user.sub);
  }

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('release-request')
  release(@Body() dto: DeviceReleaseRequestDto, @Req() req: Req_) {
    return this.releases.requestFromSignedIn(
      'CLIENT',
      req.user.sub,
      dto.reason,
    );
  }

  @Put('push-token')
  pushToken(@Body() dto: PushTokenDto, @Req() req: Req_) {
    return this.binding.updatePushToken(
      'CLIENT',
      req.user.sub,
      deviceInfoFromHeaders(req.headers)?.fingerprint,
      dto.pushToken,
    );
  }
}

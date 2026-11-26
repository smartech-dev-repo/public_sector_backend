import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';
import { HealthService } from './health/health.service';

@Controller()
export class AppController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const result = await this.healthService.check();
    res.status(result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}

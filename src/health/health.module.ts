import { Module } from '@nestjs/common';
import { HealthService } from './health.service';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [RedisModule],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}

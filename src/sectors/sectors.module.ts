import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminSectorsController } from './admin-sectors.controller';
import { SectorService } from './sector.service';

@Module({
  imports: [AuditModule],
  controllers: [AdminSectorsController],
  providers: [SectorService],
  exports: [SectorService],
})
export class SectorsModule {}

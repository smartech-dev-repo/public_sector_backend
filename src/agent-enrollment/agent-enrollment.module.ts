import { Module } from '@nestjs/common';
import { FileStorageModule } from '../file-storage/file-storage.module';
import { AgentEnrollmentController } from './agent-enrollment.controller';
import { AgentEnrollmentService } from './agent-enrollment.service';

@Module({
  imports: [FileStorageModule],
  controllers: [AgentEnrollmentController],
  providers: [AgentEnrollmentService],
})
export class AgentEnrollmentModule {}

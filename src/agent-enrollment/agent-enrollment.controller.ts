import { BadRequestException, Body, Controller, Post, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { AgentEnrollmentService } from './agent-enrollment.service';
import { RegisterAgentDto } from './dto/register-agent.dto';

@Controller('agents')
export class AgentEnrollmentController {
  constructor(private readonly agentEnrollmentService: AgentEnrollmentService) {}

  @Throttle({ default: { limit: 5, ttl: 900000 } })
  @Post('register')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cv', maxCount: 1 },
      { name: 'supportingDocuments', maxCount: 5 },
    ]),
  )
  register(
    @Body() dto: RegisterAgentDto,
    @UploadedFiles()
    files: { cv?: Express.Multer.File[]; supportingDocuments?: Express.Multer.File[] },
  ) {
    const cv = files.cv?.[0];
    if (!cv) {
      throw new BadRequestException('cv is required');
    }
    return this.agentEnrollmentService.register(dto, cv, files.supportingDocuments ?? []);
  }
}

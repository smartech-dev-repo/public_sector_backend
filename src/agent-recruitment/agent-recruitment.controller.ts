import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { AgentApplicationTokenGuard } from '../auth/agent-application-token.guard';
import { AgentRecruitmentService } from './agent-recruitment.service';
import { RequestRecruitmentCodeDto } from './dto/request-recruitment-code.dto';
import { ConfirmRecruitmentCodeDto } from './dto/confirm-recruitment-code.dto';
import { VerifyRecruitmentNinDto } from './dto/verify-recruitment-nin.dto';
import { SubmitRecruitmentApplicationDto } from './dto/submit-recruitment-application.dto';

interface ApplicationRequest {
  applicationId: string;
}

@Controller('agents/recruitment')
export class AgentRecruitmentController {
  constructor(private readonly agentRecruitmentService: AgentRecruitmentService) {}

  @Post('email/request-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async requestCode(@Body() dto: RequestRecruitmentCodeDto) {
    const result = await this.agentRecruitmentService.requestCode(dto.email);
    return { sent: true, ...result };
  }

  @Post('email/confirm-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  confirmCode(@Body() dto: ConfirmRecruitmentCodeDto) {
    return this.agentRecruitmentService.confirmCode(dto.email, dto.code);
  }

  @Get('status')
  @UseGuards(AgentApplicationTokenGuard)
  getStatus(@Req() req: ApplicationRequest) {
    return this.agentRecruitmentService.getStatus(req.applicationId);
  }

  @Post('nin/verify')
  @HttpCode(200)
  @UseGuards(AgentApplicationTokenGuard)
  verifyNin(@Body() dto: VerifyRecruitmentNinDto, @Req() req: ApplicationRequest) {
    return this.agentRecruitmentService.verifyNin(req.applicationId, dto.nin);
  }

  @Post('submit')
  @UseGuards(AgentApplicationTokenGuard)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'cv', maxCount: 1 },
      { name: 'passportPhoto', maxCount: 1 },
      { name: 'identityDocument', maxCount: 1 },
    ]),
  )
  submit(
    @Body() dto: SubmitRecruitmentApplicationDto,
    @UploadedFiles()
    files: {
      cv?: Express.Multer.File[];
      passportPhoto?: Express.Multer.File[];
      identityDocument?: Express.Multer.File[];
    },
    @Req() req: ApplicationRequest,
  ) {
    const cv = files.cv?.[0];
    const passportPhoto = files.passportPhoto?.[0];
    if (!cv) {
      throw new BadRequestException('cv is required');
    }
    if (!passportPhoto) {
      throw new BadRequestException('passportPhoto is required');
    }
    return this.agentRecruitmentService.submit(req.applicationId, dto, {
      cv,
      passportPhoto,
      identityDocument: files.identityDocument?.[0],
    });
  }
}

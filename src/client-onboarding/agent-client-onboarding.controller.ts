import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AgentOwnsClientGuard } from '../auth/agent-owns-client.guard';
import { AuditEvent } from '../audit/audit-event.decorator';
import { AuditEventInterceptor } from '../audit/audit-event.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AgentOnlyGuard } from '../auth/agent-only.guard';
import { AgentCanOnboardClientsGuard } from '../auth/agent-can-onboard-clients.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientOnboardingService } from './client-onboarding.service';
import { StaffOnboardingLookupDto } from './dto/staff-onboarding-lookup.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { ClientDocumentType } from '../generated/prisma/client';

@Controller('agent/clients')
@UseGuards(JwtAuthGuard, AgentOnlyGuard, AgentCanOnboardClientsGuard)
@UseInterceptors(AuditEventInterceptor)
export class AgentClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('onboarding/ippis-lookup')
  @AuditEvent({ action: 'client.onboarding.started', targetType: 'Client', targetId: { result: 'clientId' }, result: ['step', 'identityVerified', 'faceMatchPassed'] })
  startOnboarding(@Body() dto: StaffOnboardingLookupDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.agentStartOnboarding(dto.ippisNumber, dto.phone, req.user.sub);
  }

  @Post(':clientId/onboarding/identity')
  @UseGuards(AgentOwnsClientGuard)
  @AuditEvent({ action: 'client.onboarding.identity_submitted', targetType: 'Client', targetId: { param: 'clientId' }, result: ['step', 'identityVerified', 'faceMatchPassed'] })
  submitIdentity(@Param('clientId') clientId: string, @Body() dto: SubmitIdentityDto) {
    return this.clientOnboardingService.submitIdentityVerified(clientId, dto.bvn, dto.nin);
  }

  @Post(':clientId/onboarding/documents/:type')
  @UseGuards(AgentOwnsClientGuard)
  @AuditEvent({ action: 'client.onboarding.document_uploaded', targetType: 'Client', targetId: { param: 'clientId' }, params: ['type'] })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (
        _req: Express.Request,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf'];
        if (!allowedMimeTypes.includes(file.mimetype)) {
          callback(new BadRequestException('Only JPEG, PNG, or PDF files are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  uploadDocument(
    @Param('clientId') clientId: string,
    @Param('type', new ParseEnumPipe(ClientDocumentType)) type: ClientDocumentType,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.clientOnboardingService.uploadDocument(clientId, type, file);
  }

  @Post(':clientId/onboarding/face-match')
  @UseGuards(AgentOwnsClientGuard)
  @AuditEvent({ action: 'client.onboarding.face_match', targetType: 'Client', targetId: { param: 'clientId' }, result: ['step', 'identityVerified', 'faceMatchPassed'] })
  submitFaceMatch(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.submitFaceMatchFromPassportPhoto(clientId);
  }

  @Get(':clientId/onboarding/status')
  @UseGuards(AgentOwnsClientGuard)
  getStatus(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.getStatus(clientId);
  }
}

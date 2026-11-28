import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuditEvent } from '../audit/audit-event.decorator';
import { AuditEventInterceptor } from '../audit/audit-event.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientOnboardingService } from './client-onboarding.service';
import { LinkIppisDto } from './dto/link-ippis.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { UpdateMaritalStatusDto } from './dto/update-marital-status.dto';
import { ClientDocumentType } from '../generated/prisma/client';
import { KYC_DOCUMENT, PHOTO, multerLimits } from '../upload-validation/upload-policies';
import { ValidateUpload, ValidatedFile } from '../upload-validation/validate-upload.pipe';

@Controller('client/onboarding')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
@UseInterceptors(AuditEventInterceptor)
export class ClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('ippis-link')
  @AuditEvent({ action: 'client.onboarding.ippis_linked', targetType: 'Client', targetId: 'self', result: ['step', 'identityVerified', 'faceMatchPassed'] })
  linkIppis(@Body() dto: LinkIppisDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.linkIppis(req.user.sub, dto.ippisNumber);
  }

  @Post('identity')
  @AuditEvent({ action: 'client.onboarding.identity_submitted', targetType: 'Client', targetId: 'self', result: ['step', 'identityVerified', 'faceMatchPassed'] })
  submitIdentity(@Body() dto: SubmitIdentityDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.submitIdentity(req.user.sub, dto.bvn, dto.nin);
  }

  @Post('face-match')
  @AuditEvent({ action: 'client.onboarding.face_match', targetType: 'Client', targetId: 'self', result: ['step', 'identityVerified', 'faceMatchPassed'] })
  @UseInterceptors(
    FileInterceptor('selfie', { limits: multerLimits(PHOTO) }),
  )
  submitFaceMatch(@UploadedFile(new ValidateUpload(PHOTO, 'selfie')) file: ValidatedFile, @Req() req: { user: JwtPayload }) {
    if (!file) {
      throw new BadRequestException('selfie is required');
    }
    return this.clientOnboardingService.submitFaceMatch(req.user.sub, file.buffer);
  }

  @Get('status')
  getStatus(@Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.getStatus(req.user.sub);
  }

  @Patch('marital-status')
  @AuditEvent({ action: 'client.onboarding.marital_status_updated', targetType: 'Client', targetId: 'self' })
  updateMaritalStatus(@Body() dto: UpdateMaritalStatusDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.updateMaritalStatus(req.user.sub, dto.maritalStatus);
  }

  @Post('documents/:type')
  @AuditEvent({ action: 'client.onboarding.document_uploaded', targetType: 'Client', targetId: 'self', params: ['type'] })
  @UseInterceptors(
    FileInterceptor('file', { limits: multerLimits(KYC_DOCUMENT) }),
  )
  uploadDocument(
    @Param('type', new ParseEnumPipe(ClientDocumentType)) type: ClientDocumentType,
    @UploadedFile(new ValidateUpload(KYC_DOCUMENT, 'file')) file: ValidatedFile,
    @Req() req: { user: JwtPayload },
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    return this.clientOnboardingService.uploadDocument(req.user.sub, type, file);
  }
}

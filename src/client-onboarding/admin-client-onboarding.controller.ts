import { ClientInScope } from '../auth/client-scope.guard';
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
import { AuditEvent } from '../audit/audit-event.decorator';
import { AuditEventInterceptor } from '../audit/audit-event.interceptor';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { ClientOnboardingService } from './client-onboarding.service';
import { StaffOnboardingLookupDto } from './dto/staff-onboarding-lookup.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';
import { ClientDocumentType } from '../generated/prisma/client';

@Controller('admin/clients')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@UseInterceptors(AuditInterceptor, AuditEventInterceptor)
export class AdminClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('onboarding/ippis-lookup')
  @AuditEvent({ action: 'client.onboarding.started', targetType: 'Client', targetId: { result: 'clientId' }, result: ['step', 'identityVerified', 'faceMatchPassed'] })
  @RequirePermissions('clients:onboard')
  startOnboarding(@Body() dto: StaffOnboardingLookupDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.adminStartOnboarding(dto.ippisNumber, dto.phone, req.user.sub);
  }

  @Post(':clientId/onboarding/identity')
  @ClientInScope('clientId')
  @AuditEvent({ action: 'client.onboarding.identity_submitted', targetType: 'Client', targetId: { param: 'clientId' }, result: ['step', 'identityVerified', 'faceMatchPassed'] })
  @RequirePermissions('clients:onboard')
  submitIdentity(@Param('clientId') clientId: string, @Body() dto: SubmitIdentityDto) {
    return this.clientOnboardingService.submitIdentityVerified(clientId, dto.bvn, dto.nin);
  }

  @Post(':clientId/onboarding/documents/:type')
  @ClientInScope('clientId')
  @AuditEvent({ action: 'client.onboarding.document_uploaded', targetType: 'Client', targetId: { param: 'clientId' }, params: ['type'] })
  @RequirePermissions('clients:onboard')
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
  @ClientInScope('clientId')
  @AuditEvent({ action: 'client.onboarding.face_match', targetType: 'Client', targetId: { param: 'clientId' }, result: ['step', 'identityVerified', 'faceMatchPassed'] })
  @RequirePermissions('clients:onboard')
  submitFaceMatch(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.submitFaceMatchFromPassportPhoto(clientId);
  }

  @Get(':clientId/onboarding/status')
  @ClientInScope('clientId')
  @RequirePermissions('clients:onboard')
  getStatus(@Param('clientId') clientId: string) {
    return this.clientOnboardingService.getStatus(clientId);
  }
}

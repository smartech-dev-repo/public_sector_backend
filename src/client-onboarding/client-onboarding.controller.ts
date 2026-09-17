import { Body, Controller, Get, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ClientOnlyGuard } from '../auth/client-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { ClientOnboardingService } from './client-onboarding.service';
import { LinkIppisDto } from './dto/link-ippis.dto';
import { SubmitIdentityDto } from './dto/submit-identity.dto';

@Controller('client/onboarding')
@UseGuards(JwtAuthGuard, ClientOnlyGuard)
export class ClientOnboardingController {
  constructor(private readonly clientOnboardingService: ClientOnboardingService) {}

  @Post('ippis-link')
  linkIppis(@Body() dto: LinkIppisDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.linkIppis(req.user.sub, dto.ippisNumber);
  }

  @Post('identity')
  submitIdentity(@Body() dto: SubmitIdentityDto, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.submitIdentity(req.user.sub, dto.bvn, dto.nin);
  }

  @Post('face-match')
  @UseInterceptors(FileInterceptor('selfie'))
  submitFaceMatch(@UploadedFile() file: Express.Multer.File, @Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.submitFaceMatch(req.user.sub, file.buffer);
  }

  @Get('status')
  getStatus(@Req() req: { user: JwtPayload }) {
    return this.clientOnboardingService.getStatus(req.user.sub);
  }
}

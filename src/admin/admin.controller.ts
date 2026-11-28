import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminOnlyGuard } from '../auth/admin-only.guard';
import { JwtPayload } from '../auth/jwt-payload.interface';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AdminService } from './admin.service';
import { UpdateAdminProfileDto } from './dto/update-admin-profile.dto';
import { PHOTO, multerLimits } from '../upload-validation/upload-policies';
import { ValidateUpload, ValidatedFile } from '../upload-validation/validate-upload.pipe';

@Controller('admin')
@UseInterceptors(AuditInterceptor)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async me(@Req() req: { user: JwtPayload }) {
    const profile = await this.adminService.getProfile(req.user.sub);
    return { ...profile, permissions: req.user.permissions };
  }

  @Patch('me')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async updateMe(@Body() dto: UpdateAdminProfileDto, @Req() req: { user: JwtPayload }) {
    const profile = await this.adminService.updateProfile(req.user.sub, dto);
    return { ...profile, permissions: req.user.permissions };
  }

  @Post('me/profile-image')
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: multerLimits(PHOTO) }),
  )
  async uploadProfileImage(@UploadedFile(new ValidateUpload(PHOTO, 'file')) file: ValidatedFile, @Req() req: { user: JwtPayload }) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    const profile = await this.adminService.uploadProfileImage(req.user.sub, file);
    return { ...profile, permissions: req.user.permissions };
  }

  @Delete('me/profile-image')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, AdminOnlyGuard)
  async deleteProfileImage(@Req() req: { user: JwtPayload }) {
    const profile = await this.adminService.deleteProfileImage(req.user.sub);
    return { ...profile, permissions: req.user.permissions };
  }
}

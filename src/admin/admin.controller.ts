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
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (
        _req: Express.Request,
        file: Express.Multer.File,
        callback: (error: Error | null, acceptFile: boolean) => void,
      ) => {
        if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
          callback(new BadRequestException('Only JPEG or PNG files are allowed'), false);
          return;
        }
        callback(null, true);
      },
    }),
  )
  async uploadProfileImage(@UploadedFile() file: Express.Multer.File, @Req() req: { user: JwtPayload }) {
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

import { Controller, Get, Inject, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from './file-storage-provider.interface';

@Controller('admin/documents/files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FileDownloadController {
  constructor(
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  @Get(':key')
  @RequirePermissions('documents:read')
  async download(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const content = await this.fileStorageProvider.getObject(decodeURIComponent(key));
    res.send(content);
  }
}

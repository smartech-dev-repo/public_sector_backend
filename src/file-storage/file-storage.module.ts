import { Module } from '@nestjs/common';
import { LocalFileStorageProvider } from './local-file-storage.provider';
import { FILE_STORAGE_PROVIDER } from './file-storage-provider.interface';
import { FileDownloadController } from './file-download.controller';

@Module({
  controllers: [FileDownloadController],
  providers: [{ provide: FILE_STORAGE_PROVIDER, useClass: LocalFileStorageProvider }],
  exports: [FILE_STORAGE_PROVIDER],
})
export class FileStorageModule {}

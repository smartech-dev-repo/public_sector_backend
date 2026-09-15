import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LocalFileStorageProvider } from './local-file-storage.provider';
import { S3FileStorageProvider } from './s3-file-storage.provider';
import { GcsFileStorageProvider } from './gcs-file-storage.provider';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from './file-storage-provider.interface';
import { FileDownloadController } from './file-download.controller';

@Module({
  controllers: [FileDownloadController],
  providers: [
    LocalFileStorageProvider,
    S3FileStorageProvider,
    GcsFileStorageProvider,
    {
      provide: FILE_STORAGE_PROVIDER,
      useFactory: (
        configService: ConfigService,
        local: LocalFileStorageProvider,
        s3: S3FileStorageProvider,
        gcs: GcsFileStorageProvider,
      ): FileStorageProvider => {
        const provider = configService.get<string>('STORAGE_PROVIDER', 'local');
        if (provider === 's3') {
          return s3;
        }
        if (provider === 'gcs') {
          return gcs;
        }
        return local;
      },
      inject: [ConfigService, LocalFileStorageProvider, S3FileStorageProvider, GcsFileStorageProvider],
    },
  ],
  exports: [FILE_STORAGE_PROVIDER],
})
export class FileStorageModule {}

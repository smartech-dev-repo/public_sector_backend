import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3CompatibleFileStorageProvider } from './s3-compatible-file-storage.provider';

/** AWS S3. Selected with STORAGE_PROVIDER=s3. */
@Injectable()
export class S3FileStorageProvider extends S3CompatibleFileStorageProvider {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  protected bucketName(): string {
    return this.configService.getOrThrow<string>('AWS_S3_BUCKET');
  }

  protected clientConfig(): S3ClientConfig {
    return {
      region: this.configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: this.configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
    };
  }
}

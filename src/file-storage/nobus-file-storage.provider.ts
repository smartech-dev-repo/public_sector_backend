import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3ClientConfig } from '@aws-sdk/client-s3';
import { S3CompatibleFileStorageProvider } from './s3-compatible-file-storage.provider';

export const NOBUS_DEFAULT_ENDPOINT = 'https://fos-az1-store.nobus.io';
export const NOBUS_DEFAULT_REGION = 'RegionOne';

/**
 * Nobus Object Storage, through its S3-compatible API. Selected with STORAGE_PROVIDER=nobus.
 *
 * The access key and secret are the "EC2 credentials" under Settings & help → API keys in the
 * Nobus dashboard (admin/root account). Nobus is not AWS:
 * - buckets are addressed in the path (https://endpoint/bucket/key), not as a subdomain;
 * - checksums are sent only when an operation requires them. Recent AWS SDKs add CRC checksum
 *   headers to every upload by default, which S3-compatible stores often reject.
 */
@Injectable()
export class NobusFileStorageProvider extends S3CompatibleFileStorageProvider {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  protected bucketName(): string {
    return this.configService.getOrThrow<string>('NOBUS_BUCKET_NAME');
  }

  protected clientConfig(): S3ClientConfig {
    return {
      endpoint:
        this.configService.get<string>('NOBUS_S3_ENDPOINT') ||
        NOBUS_DEFAULT_ENDPOINT,
      region:
        this.configService.get<string>('NOBUS_REGION') || NOBUS_DEFAULT_REGION,
      credentials: {
        accessKeyId: this.configService.getOrThrow<string>(
          'NOBUS_ACCESS_KEY_ID',
        ),
        secretAccessKey: this.configService.getOrThrow<string>(
          'NOBUS_SECRET_ACCESS_KEY',
        ),
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
  }
}

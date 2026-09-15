import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileStorageProvider } from './file-storage-provider.interface';

const SIGNED_URL_TTL_SECONDS = 3600;

@Injectable()
export class S3FileStorageProvider implements FileStorageProvider {
  private client?: S3Client;
  private bucketName?: string;

  constructor(private readonly configService: ConfigService) {}

  // Credentials are read and the SDK client is constructed lazily, on first
  // use, not in the constructor. FileStorageModule always constructs every
  // concrete provider (local/S3/GCS) so it can pick one at runtime via
  // STORAGE_PROVIDER — eagerly requiring AWS_* env vars here would break app
  // startup whenever S3 isn't the selected provider (e.g. local dev/tests).
  private getBucket(): string {
    if (!this.bucketName) {
      this.bucketName = this.configService.getOrThrow<string>('AWS_S3_BUCKET');
    }
    return this.bucketName;
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: this.configService.getOrThrow<string>('AWS_REGION'),
        credentials: {
          accessKeyId: this.configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
          secretAccessKey: this.configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
        },
      });
    }
    return this.client;
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({ Bucket: this.getBucket(), Key: key, Body: content }),
    );
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      const response = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.getBucket(), Key: key }),
      );
      const bytes = await response.Body!.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') {
        throw new NotFoundException(`File not found: ${key}`);
      }
      throw error;
    }
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.getBucket(), Key: key });
    return getSignedUrl(this.getClient(), command, { expiresIn: SIGNED_URL_TTL_SECONDS });
  }

  async deleteObject(key: string): Promise<void> {
    await this.getClient().send(new DeleteObjectCommand({ Bucket: this.getBucket(), Key: key }));
  }
}

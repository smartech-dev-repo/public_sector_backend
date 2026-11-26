import { NotFoundException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileStorageProvider } from './file-storage-provider.interface';

const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Storage over the S3 API: AWS itself, or any S3-compatible store (Nobus). Subclasses only say
 * which bucket and how to connect.
 *
 * Settings are read and the SDK client built lazily, on first use, not in the constructor.
 * FileStorageModule constructs every concrete provider so it can pick one at runtime via
 * STORAGE_PROVIDER; requiring their env vars eagerly would break startup whenever a provider
 * isn't the selected one (e.g. local dev/tests).
 */
export abstract class S3CompatibleFileStorageProvider implements FileStorageProvider {
  private client?: S3Client;
  private bucket?: string;

  protected abstract bucketName(): string;
  protected abstract clientConfig(): S3ClientConfig;

  private getBucket(): string {
    if (!this.bucket) {
      this.bucket = this.bucketName();
    }
    return this.bucket;
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client(this.clientConfig());
    }
    return this.client;
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({
        Bucket: this.getBucket(),
        Key: key,
        Body: content,
      }),
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
    const command = new GetObjectCommand({
      Bucket: this.getBucket(),
      Key: key,
    });
    return getSignedUrl(this.getClient(), command, {
      expiresIn: SIGNED_URL_TTL_SECONDS,
    });
  }

  async deleteObject(key: string): Promise<void> {
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: this.getBucket(), Key: key }),
    );
  }
}

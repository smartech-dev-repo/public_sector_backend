import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import { FileStorageProvider } from './file-storage-provider.interface';

const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class GcsFileStorageProvider implements FileStorageProvider {
  private storage?: Storage;
  private bucketName?: string;

  constructor(private readonly configService: ConfigService) {}

  // Same lazy-initialization reasoning as S3FileStorageProvider — see its
  // comment. Constructed on first use, not in the constructor.
  private getBucketName(): string {
    if (!this.bucketName) {
      this.bucketName = this.configService.getOrThrow<string>('GCS_BUCKET');
    }
    return this.bucketName;
  }

  private getStorage(): Storage {
    if (!this.storage) {
      this.storage = new Storage({
        projectId: this.configService.getOrThrow<string>('GCP_PROJECT_ID'),
        credentials: {
          client_email: this.configService.getOrThrow<string>('GCP_CLIENT_EMAIL'),
          private_key: this.configService
            .getOrThrow<string>('GCP_PRIVATE_KEY')
            .replace(/\\n/g, '\n'),
        },
      });
    }
    return this.storage;
  }

  private file(key: string) {
    return this.getStorage().bucket(this.getBucketName()).file(key);
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    await this.file(key).save(content);
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      const [content] = await this.file(key).download();
      return content;
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code === 404) {
        throw new NotFoundException(`File not found: ${key}`);
      }
      throw error;
    }
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    const [url] = await this.file(key).getSignedUrl({
      action: 'read',
      expires: Date.now() + SIGNED_URL_TTL_MS,
    });
    return url;
  }

  async deleteObject(key: string): Promise<void> {
    await this.file(key).delete();
  }
}

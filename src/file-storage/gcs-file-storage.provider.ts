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
      this.bucketName = this.configService.getOrThrow<string>('GCP_BUCKET_NAME');
    }
    return this.bucketName;
  }

  // GCP_CREDENTIALS_FILE (a local key file) is used when set — the normal
  // path for local dev. GCP_CREDENTIALS_JSON (the key file's raw contents,
  // one environment variable) is the fallback for platforms like Dokploy
  // that inject secrets purely via env vars with no file mount available.
  private getStorage(): Storage {
    if (!this.storage) {
      const credentialsFile = this.configService.get<string>('GCP_CREDENTIALS_FILE');
      if (credentialsFile) {
        this.storage = new Storage({ keyFilename: credentialsFile });
      } else {
        const credentialsJson = this.configService.getOrThrow<string>('GCP_CREDENTIALS_JSON');
        this.storage = new Storage({ credentials: JSON.parse(credentialsJson) });
      }
    }
    return this.storage;
  }

  // Optional prefix so multiple apps/environments can share one bucket
  // without colliding — mirrors the reasoning behind this project's
  // REDIS_KEY_PREFIX convention.
  private resolveKey(key: string): string {
    const subPath = this.configService.get<string>('GCP_SUB_PATH', '').replace(/^\/+|\/+$/g, '');
    return subPath ? `${subPath}/${key}` : key;
  }

  private file(key: string) {
    return this.getStorage().bucket(this.getBucketName()).file(this.resolveKey(key));
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

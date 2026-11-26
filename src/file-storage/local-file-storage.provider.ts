import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FileStorageProvider } from './file-storage-provider.interface';

@Injectable()
export class LocalFileStorageProvider implements FileStorageProvider {
  constructor(private readonly configService: ConfigService) {}

  private baseDir(): string {
    return this.configService.get<string>('LOCAL_STORAGE_DIR', './storage');
  }

  private resolvePath(key: string): string {
    return path.join(this.baseDir(), key);
  }

  async putObject(key: string, content: Buffer): Promise<void> {
    const filePath = this.resolvePath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolvePath(key));
    } catch {
      throw new NotFoundException(`File not found: ${key}`);
    }
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    return `/admin/documents/files/${encodeURIComponent(key)}`;
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.resolvePath(key), { force: true });
  }
}

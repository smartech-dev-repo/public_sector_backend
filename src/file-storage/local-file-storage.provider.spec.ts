import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LocalFileStorageProvider } from './local-file-storage.provider';

describe('LocalFileStorageProvider', () => {
  let provider: LocalFileStorageProvider;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `file-storage-test-${Date.now()}`);
    const configService = {
      get: jest.fn().mockReturnValue(testDir),
    } as unknown as ConfigService;
    provider = new LocalFileStorageProvider(configService);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('writes and reads back a file, creating parent directories as needed', async () => {
    await provider.putObject('snapshots/ippis/2026-09-15.csv', Buffer.from('a,b,c'));
    const content = await provider.getObject('snapshots/ippis/2026-09-15.csv');
    expect(content.toString('utf-8')).toBe('a,b,c');
  });

  it('throws NotFoundException for a key that was never written', async () => {
    await expect(provider.getObject('does/not/exist.csv')).rejects.toThrow(NotFoundException);
  });

  it('returns an app-relative download URL', async () => {
    const url = await provider.getSignedDownloadUrl('snapshots/ippis/2026-09-15.csv');
    expect(url).toBe('/admin/documents/files/snapshots%2Fippis%2F2026-09-15.csv');
  });

  it('deleteObject removes the file so a later getObject throws', async () => {
    await provider.putObject('to-delete.csv', Buffer.from('x'));
    await provider.deleteObject('to-delete.csv');
    await expect(provider.getObject('to-delete.csv')).rejects.toThrow(NotFoundException);
  });

  it('deleteObject on a nonexistent key does not throw', async () => {
    await expect(provider.deleteObject('never-existed.csv')).resolves.toBeUndefined();
  });
});

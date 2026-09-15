import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import { GcsFileStorageProvider } from './gcs-file-storage.provider';

jest.mock('@google-cloud/storage');

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

describe('GcsFileStorageProvider', () => {
  const config = fakeConfig({
    GCP_PROJECT_ID: 'test-project',
    GCP_CLIENT_EMAIL: 'sa@test-project.iam.gserviceaccount.com',
    GCP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n',
    GCS_BUCKET: 'test-bucket',
  });
  let provider: GcsFileStorageProvider;
  let fileMock: {
    save: jest.Mock;
    download: jest.Mock;
    delete: jest.Mock;
    getSignedUrl: jest.Mock;
  };
  let bucketMock: { file: jest.Mock };

  beforeEach(() => {
    fileMock = {
      save: jest.fn(),
      download: jest.fn(),
      delete: jest.fn(),
      getSignedUrl: jest.fn(),
    };
    bucketMock = { file: jest.fn().mockReturnValue(fileMock) };
    (Storage as unknown as jest.Mock).mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue(bucketMock),
    }));

    provider = new GcsFileStorageProvider(config);
  });

  it('putObject saves the buffer to the keyed file', async () => {
    fileMock.save.mockResolvedValue(undefined);
    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(bucketMock.file).toHaveBeenCalledWith('uploads/file.xlsx');
    expect(fileMock.save).toHaveBeenCalledWith(Buffer.from('data'));
  });

  it('getObject downloads and returns the file contents as a Buffer', async () => {
    fileMock.download.mockResolvedValue([Buffer.from('hello')]);
    const result = await provider.getObject('uploads/file.xlsx');
    expect(result.toString('utf-8')).toBe('hello');
  });

  it('getObject throws NotFoundException when GCS reports the object is missing', async () => {
    fileMock.download.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));
    await expect(provider.getObject('missing.xlsx')).rejects.toThrow(NotFoundException);
  });

  it('getSignedDownloadUrl returns a signed read URL', async () => {
    fileMock.getSignedUrl.mockResolvedValue(['https://storage.googleapis.com/signed-url']);
    const url = await provider.getSignedDownloadUrl('uploads/file.xlsx');

    expect(fileMock.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'read' }),
    );
    expect(url).toBe('https://storage.googleapis.com/signed-url');
  });

  it('deleteObject deletes the keyed file', async () => {
    fileMock.delete.mockResolvedValue(undefined);
    await provider.deleteObject('uploads/file.xlsx');
    expect(fileMock.delete).toHaveBeenCalled();
  });
});

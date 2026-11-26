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
    get: (key: string, defaultValue?: string) => (key in values ? values[key] : defaultValue),
  } as unknown as ConfigService;
}

describe('GcsFileStorageProvider', () => {
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
  });

  it('constructs the Storage client from GCP_CREDENTIALS_FILE via keyFilename', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_FILE: './gcp-credentials.json' });
    const provider = new GcsFileStorageProvider(config);
    fileMock.save.mockResolvedValue(undefined);

    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(Storage).toHaveBeenCalledWith({ keyFilename: './gcp-credentials.json' });
  });

  it('constructs the Storage client from GCP_CREDENTIALS_JSON when no file path is configured', async () => {
    const credentials = { client_email: 'sa@test.iam.gserviceaccount.com', private_key: 'fake-key' };
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_JSON: JSON.stringify(credentials) });
    const provider = new GcsFileStorageProvider(config);
    fileMock.save.mockResolvedValue(undefined);

    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(Storage).toHaveBeenCalledWith({ credentials });
  });

  it('prefers GCP_CREDENTIALS_FILE over GCP_CREDENTIALS_JSON when both are set', async () => {
    const config = fakeConfig({
      GCP_BUCKET_NAME: 'test-bucket',
      GCP_CREDENTIALS_FILE: './gcp-credentials.json',
      GCP_CREDENTIALS_JSON: JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com' }),
    });
    const provider = new GcsFileStorageProvider(config);
    fileMock.save.mockResolvedValue(undefined);

    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(Storage).toHaveBeenCalledWith({ keyFilename: './gcp-credentials.json' });
  });

  it('throws when neither GCP_CREDENTIALS_FILE nor GCP_CREDENTIALS_JSON is configured', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket' });
    const provider = new GcsFileStorageProvider(config);

    await expect(provider.putObject('uploads/file.xlsx', Buffer.from('data'))).rejects.toThrow();
  });

  it('putObject saves the buffer to the keyed file when no sub-path is configured', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_FILE: './gcp-credentials.json' });
    const provider = new GcsFileStorageProvider(config);
    fileMock.save.mockResolvedValue(undefined);

    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(bucketMock.file).toHaveBeenCalledWith('uploads/file.xlsx');
    expect(fileMock.save).toHaveBeenCalledWith(Buffer.from('data'));
  });

  it('prefixes the key with GCP_SUB_PATH when configured', async () => {
    const config = fakeConfig({
      GCP_BUCKET_NAME: 'test-bucket',
      GCP_CREDENTIALS_FILE: './gcp-credentials.json',
      GCP_SUB_PATH: 'camco',
    });
    const provider = new GcsFileStorageProvider(config);
    fileMock.save.mockResolvedValue(undefined);

    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(bucketMock.file).toHaveBeenCalledWith('camco/uploads/file.xlsx');
  });

  it('trims stray slashes from GCP_SUB_PATH before prefixing', async () => {
    const config = fakeConfig({
      GCP_BUCKET_NAME: 'test-bucket',
      GCP_CREDENTIALS_FILE: './gcp-credentials.json',
      GCP_SUB_PATH: '/camco/',
    });
    const provider = new GcsFileStorageProvider(config);
    fileMock.save.mockResolvedValue(undefined);

    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(bucketMock.file).toHaveBeenCalledWith('camco/uploads/file.xlsx');
  });

  it('getObject downloads and returns the file contents as a Buffer', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_FILE: './gcp-credentials.json' });
    const provider = new GcsFileStorageProvider(config);
    fileMock.download.mockResolvedValue([Buffer.from('hello')]);

    const result = await provider.getObject('uploads/file.xlsx');
    expect(result.toString('utf-8')).toBe('hello');
  });

  it('getObject throws NotFoundException when GCS reports the object is missing', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_FILE: './gcp-credentials.json' });
    const provider = new GcsFileStorageProvider(config);
    fileMock.download.mockRejectedValue(Object.assign(new Error('not found'), { code: 404 }));

    await expect(provider.getObject('missing.xlsx')).rejects.toThrow(NotFoundException);
  });

  it('getSignedDownloadUrl returns a signed read URL', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_FILE: './gcp-credentials.json' });
    const provider = new GcsFileStorageProvider(config);
    fileMock.getSignedUrl.mockResolvedValue(['https://storage.googleapis.com/signed-url']);

    const url = await provider.getSignedDownloadUrl('uploads/file.xlsx');

    expect(fileMock.getSignedUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'read' }),
    );
    expect(url).toBe('https://storage.googleapis.com/signed-url');
  });

  it('deleteObject deletes the keyed file', async () => {
    const config = fakeConfig({ GCP_BUCKET_NAME: 'test-bucket', GCP_CREDENTIALS_FILE: './gcp-credentials.json' });
    const provider = new GcsFileStorageProvider(config);
    fileMock.delete.mockResolvedValue(undefined);

    await provider.deleteObject('uploads/file.xlsx');
    expect(fileMock.delete).toHaveBeenCalled();
  });
});

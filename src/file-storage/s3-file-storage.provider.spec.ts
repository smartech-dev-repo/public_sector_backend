import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3FileStorageProvider } from './s3-file-storage.provider';

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

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

describe('S3FileStorageProvider', () => {
  const config = fakeConfig({
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'key',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_S3_BUCKET: 'test-bucket',
  });
  let provider: S3FileStorageProvider;

  function getSendMock(): jest.Mock {
    // The S3Client is constructed lazily on first use (see the provider's
    // comment), so the mock instance only exists in mock.results after the
    // provider's first operation has run.
    return (S3Client as unknown as jest.Mock).mock.results[0].value.send;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new S3FileStorageProvider(config);
  });

  it('putObject sends a PutObjectCommand with the bucket, key, and body', async () => {
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) }));
    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    const sendMock = getSendMock();
    expect(sendMock).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    const command = sendMock.mock.calls[0][0] as PutObjectCommand;
    expect(command.input).toEqual({ Bucket: 'test-bucket', Key: 'uploads/file.xlsx', Body: Buffer.from('data') });
  });

  it('getObject sends a GetObjectCommand and returns the body as a Buffer', async () => {
    const chunks = [Buffer.from('hello')];
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({
      send: jest.fn().mockResolvedValue({
        Body: { transformToByteArray: async () => Buffer.concat(chunks) },
      }),
    }));

    const result = await provider.getObject('uploads/file.xlsx');

    expect(getSendMock()).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    expect(result.toString('utf-8')).toBe('hello');
  });

  it('getObject throws NotFoundException when S3 reports the key is missing', async () => {
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({
      send: jest.fn().mockRejectedValue(Object.assign(new Error('not found'), { name: 'NoSuchKey' })),
    }));
    await expect(provider.getObject('missing.xlsx')).rejects.toThrow(NotFoundException);
  });

  it('getSignedDownloadUrl delegates to the presigner with a GetObjectCommand', async () => {
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send: jest.fn() }));
    (getSignedUrl as jest.Mock).mockResolvedValue('https://signed.example.com/uploads/file.xlsx');

    const url = await provider.getSignedDownloadUrl('uploads/file.xlsx');

    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(GetObjectCommand),
      expect.objectContaining({ expiresIn: expect.any(Number) }),
    );
    expect(url).toBe('https://signed.example.com/uploads/file.xlsx');
  });

  it('deleteObject sends a DeleteObjectCommand', async () => {
    (S3Client as unknown as jest.Mock).mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) }));
    await provider.deleteObject('uploads/file.xlsx');

    expect(getSendMock()).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
  });
});

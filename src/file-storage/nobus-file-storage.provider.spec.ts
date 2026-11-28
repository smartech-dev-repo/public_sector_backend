import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  NOBUS_DEFAULT_ENDPOINT,
  NOBUS_DEFAULT_REGION,
  NobusFileStorageProvider,
} from './nobus-file-storage.provider';

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest
      .fn()
      .mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  };
});
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) {
        throw new Error(`Missing config: ${key}`);
      }
      return values[key];
    },
  } as unknown as ConfigService;
}

const REQUIRED = {
  NOBUS_ACCESS_KEY_ID: 'nobus-key',
  NOBUS_SECRET_ACCESS_KEY: 'nobus-secret',
  NOBUS_BUCKET_NAME: 'ps-documents',
};

describe('NobusFileStorageProvider', () => {
  const S3ClientMock = S3Client as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('connects to the Nobus endpoint with path-style buckets and checksums only when required', async () => {
    const provider = new NobusFileStorageProvider(fakeConfig(REQUIRED));
    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    expect(S3ClientMock).toHaveBeenCalledWith({
      endpoint: NOBUS_DEFAULT_ENDPOINT,
      region: NOBUS_DEFAULT_REGION,
      credentials: {
        accessKeyId: 'nobus-key',
        secretAccessKey: 'nobus-secret',
      },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    expect(NOBUS_DEFAULT_ENDPOINT).toBe('https://fos-az1-store.nobus.io');
    expect(NOBUS_DEFAULT_REGION).toBe('RegionOne');
  });

  it('uses NOBUS_S3_ENDPOINT and NOBUS_REGION when set', async () => {
    const provider = new NobusFileStorageProvider(
      fakeConfig({
        ...REQUIRED,
        NOBUS_S3_ENDPOINT: 'https://other.nobus.io',
        NOBUS_REGION: 'RegionTwo',
      }),
    );
    await provider.putObject('k', Buffer.from('x'));

    expect(S3ClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://other.nobus.io',
        region: 'RegionTwo',
      }),
    );
  });

  it('puts objects into the Nobus bucket', async () => {
    const provider = new NobusFileStorageProvider(fakeConfig(REQUIRED));
    await provider.putObject('uploads/file.xlsx', Buffer.from('data'));

    const send = S3ClientMock.mock.results[0].value.send as jest.Mock;
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'ps-documents',
      Key: 'uploads/file.xlsx',
      Body: Buffer.from('data'),
      ContentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  });

  it('signs download URLs against the Nobus bucket', async () => {
    (getSignedUrl as jest.Mock).mockResolvedValue(
      'https://fos-az1-store.nobus.io/ps-documents/k?sig',
    );
    const provider = new NobusFileStorageProvider(fakeConfig(REQUIRED));

    await expect(provider.getSignedDownloadUrl('k')).resolves.toBe(
      'https://fos-az1-store.nobus.io/ps-documents/k?sig',
    );
    const command = (getSignedUrl as jest.Mock).mock
      .calls[0][1] as GetObjectCommand;
    expect(command.input).toEqual({ Bucket: 'ps-documents', Key: 'k' });
  });

  it('does not need its settings until first used, and names the missing one then', async () => {
    const provider = new NobusFileStorageProvider(fakeConfig({}));
    expect(S3ClientMock).not.toHaveBeenCalled();
    await expect(provider.putObject('k', Buffer.from('x'))).rejects.toThrow(
      /Missing config: NOBUS_/,
    );
  });
});

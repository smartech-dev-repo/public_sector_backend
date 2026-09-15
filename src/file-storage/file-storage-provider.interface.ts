export const FILE_STORAGE_PROVIDER = Symbol('FILE_STORAGE_PROVIDER');

export interface FileStorageProvider {
  putObject(key: string, content: Buffer): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  getSignedDownloadUrl(key: string): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

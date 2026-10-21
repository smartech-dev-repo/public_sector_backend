import { FileDownloadController } from './file-download.controller';
import { FileStorageProvider } from './file-storage-provider.interface';

describe('FileDownloadController', () => {
  let controller: FileDownloadController;
  let fileStorageProvider: { getObject: jest.Mock };
  let res: { setHeader: jest.Mock; send: jest.Mock };

  beforeEach(() => {
    fileStorageProvider = { getObject: jest.fn() };
    res = { setHeader: jest.fn(), send: jest.fn() };
    controller = new FileDownloadController(fileStorageProvider as unknown as FileStorageProvider);
  });

  it('decodes the key, fetches the object, sets Content-Type by extension, then sends the bytes', async () => {
    const content = Buffer.from('fake bytes for this test only');
    fileStorageProvider.getObject.mockResolvedValue(content);

    await controller.download('agents%2Fa1%2Fcv.pdf', res as never);

    expect(fileStorageProvider.getObject).toHaveBeenCalledWith('agents/a1/cv.pdf');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(res.send).toHaveBeenCalledWith(content);
  });

  it('sets image/jpeg for a .jpg key', async () => {
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('x'));

    await controller.download('selfies%2Fa1%2Flive.jpg', res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/jpeg');
  });

  it('sets application/octet-stream for an unrecognized extension', async () => {
    fileStorageProvider.getObject.mockResolvedValue(Buffer.from('x'));

    await controller.download('misc%2Fa1%2Fthing.bin', res as never);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/octet-stream');
  });
});

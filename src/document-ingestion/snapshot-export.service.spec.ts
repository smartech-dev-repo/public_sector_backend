import { SnapshotExportService } from './snapshot-export.service';
import { PrismaService } from '../prisma/prisma.service';
import { FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DocumentType } from '../generated/prisma/client';

describe('SnapshotExportService', () => {
  let service: SnapshotExportService;
  let prisma: { dataSnapshotExport: { create: jest.Mock } };
  let fileStorageProvider: { putObject: jest.Mock; getSignedDownloadUrl: jest.Mock };

  beforeEach(() => {
    prisma = { dataSnapshotExport: { create: jest.fn() } };
    fileStorageProvider = {
      putObject: jest.fn().mockResolvedValue(undefined),
      getSignedDownloadUrl: jest.fn().mockResolvedValue('/admin/documents/files/x'),
    };
    service = new SnapshotExportService(
      prisma as unknown as PrismaService,
      fileStorageProvider as unknown as FileStorageProvider,
    );
  });

  it('generates SQL INSERT statements for each row, escaping quotes', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    await service.exportSnapshot({
      documentType: DocumentType.IPPIS_BROADSHEET,
      tableName: 'IppisRecord',
      columns: ['staffId', 'employeeName'],
      rows: [{ staffId: 'PF001', employeeName: "O'Brien" }],
    });

    const [, sqlBuffer] = fileStorageProvider.putObject.mock.calls[0];
    expect(sqlBuffer.toString('utf-8')).toContain(
      `INSERT INTO "IppisRecord" ("staffId", "employeeName") VALUES ('PF001', 'O''Brien');`,
    );
  });

  it('writes "no records" SQL when the row set is empty', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    await service.exportSnapshot({
      documentType: DocumentType.DISBURSED_LOANS,
      tableName: 'Loan',
      columns: ['customerId'],
      rows: [],
    });

    const [, sqlBuffer] = fileStorageProvider.putObject.mock.calls[0];
    expect(sqlBuffer.toString('utf-8')).toContain('No records in Loan');
  });

  it('generates a CSV with a header row and quotes fields containing commas', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    await service.exportSnapshot({
      documentType: DocumentType.DISBURSED_LOANS,
      tableName: 'Loan',
      columns: ['customerName', 'address'],
      rows: [{ customerName: 'Doe, Jane', address: '1 Main St' }],
    });

    const csvCall = fileStorageProvider.putObject.mock.calls[1];
    const csvContent = csvCall[1].toString('utf-8');
    expect(csvContent).toContain('customerName,address');
    expect(csvContent).toContain('"Doe, Jane",1 Main St');
  });

  it('creates a DataSnapshotExport row with the record count and both URLs', async () => {
    prisma.dataSnapshotExport.create.mockResolvedValue({ id: 'snap-1' });

    const result = await service.exportSnapshot({
      documentType: DocumentType.IPPIS_BROADSHEET,
      tableName: 'IppisRecord',
      columns: ['staffId'],
      rows: [{ staffId: 'PF001' }, { staffId: 'PF002' }],
    });

    expect(prisma.dataSnapshotExport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentType: DocumentType.IPPIS_BROADSHEET,
        recordCount: 2,
        sqlUrl: '/admin/documents/files/x',
        csvUrl: '/admin/documents/files/x',
      }),
    });
    expect(result).toEqual({ id: 'snap-1' });
  });
});

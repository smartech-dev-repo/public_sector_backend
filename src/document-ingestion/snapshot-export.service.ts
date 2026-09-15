import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE_PROVIDER, FileStorageProvider } from '../file-storage/file-storage-provider.interface';
import { DataSnapshotExport, DocumentType } from '../generated/prisma/client';

export interface SnapshotExportInput {
  documentType: DocumentType;
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

@Injectable()
export class SnapshotExportService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE_PROVIDER) private readonly fileStorageProvider: FileStorageProvider,
  ) {}

  async exportSnapshot(input: SnapshotExportInput): Promise<DataSnapshotExport> {
    const sqlContent = this.buildSql(input);
    const csvContent = this.buildCsv(input);

    const timestamp = Date.now();
    const sqlKey = `snapshots/${input.documentType.toLowerCase()}/${timestamp}.sql`;
    const csvKey = `snapshots/${input.documentType.toLowerCase()}/${timestamp}.csv`;

    await this.fileStorageProvider.putObject(sqlKey, Buffer.from(sqlContent, 'utf-8'));
    await this.fileStorageProvider.putObject(csvKey, Buffer.from(csvContent, 'utf-8'));

    const sqlUrl = await this.fileStorageProvider.getSignedDownloadUrl(sqlKey);
    const csvUrl = await this.fileStorageProvider.getSignedDownloadUrl(csvKey);

    return this.prisma.dataSnapshotExport.create({
      data: {
        documentType: input.documentType,
        recordCount: input.rows.length,
        sqlStorageKey: sqlKey,
        csvStorageKey: csvKey,
        sqlUrl,
        csvUrl,
      },
    });
  }

  private buildSql(input: SnapshotExportInput): string {
    if (input.rows.length === 0) {
      return `-- No records in ${input.tableName} at export time\n`;
    }

    const columnList = input.columns.map((column) => `"${column}"`).join(', ');
    const statements = input.rows.map((row) => {
      const values = input.columns.map((column) => this.sqlValue(row[column])).join(', ');
      return `INSERT INTO "${input.tableName}" (${columnList}) VALUES (${values});`;
    });

    return statements.join('\n') + '\n';
  }

  private sqlValue(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  private buildCsv(input: SnapshotExportInput): string {
    const header = input.columns.join(',');
    const lines = input.rows.map((row) =>
      input.columns.map((column) => this.csvValue(row[column])).join(','),
    );
    return [header, ...lines].join('\n') + '\n';
  }

  private csvValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    const stringValue = value instanceof Date ? value.toISOString() : String(value);
    if (/[",\n]/.test(stringValue)) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  }
}

import { extname } from 'path';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.sql': 'application/sql',
};

export function inferContentType(key: string): string {
  return CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream';
}

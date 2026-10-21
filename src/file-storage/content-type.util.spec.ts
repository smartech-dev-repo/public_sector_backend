import { inferContentType } from './content-type.util';

describe('inferContentType', () => {
  it('maps known extensions to their MIME type', () => {
    expect(inferContentType('a/b/c.jpg')).toBe('image/jpeg');
    expect(inferContentType('a/b/c.jpeg')).toBe('image/jpeg');
    expect(inferContentType('a/b/c.png')).toBe('image/png');
    expect(inferContentType('a/b/c.pdf')).toBe('application/pdf');
    expect(inferContentType('a/b/c.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(inferContentType('a/b/c.csv')).toBe('text/csv');
    expect(inferContentType('a/b/c.sql')).toBe('application/sql');
  });

  it('is case-insensitive on the extension', () => {
    expect(inferContentType('a/b/c.JPG')).toBe('image/jpeg');
    expect(inferContentType('a/b/c.PDF')).toBe('application/pdf');
  });

  it('falls back to application/octet-stream for an unknown extension', () => {
    expect(inferContentType('a/b/c.unknown')).toBe('application/octet-stream');
    expect(inferContentType('a/b/c')).toBe('application/octet-stream');
  });
});

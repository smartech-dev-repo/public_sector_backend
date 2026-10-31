import { buildStoredFileName } from './stored-file-name.util';

describe('buildStoredFileName', () => {
  const now = new Date('2026-10-31T23:15:07Z');

  it('combines the original name with the Lagos date and time of upload', () => {
    expect(buildStoredFileName('IPPIS Oct (final).XLSX', now)).toMatch(/^ippis-oct-final_01-nov-2026_00-15-07_[0-9a-f]{6}\.xlsx$/);
  });

  it('never lets the original name add a path segment', () => {
    const name = buildStoredFileName('../../etc/passwd.xlsx', now);
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('falls back when nothing usable is left of the name', () => {
    expect(buildStoredFileName('???.xlsx', now)).toMatch(/^upload_/);
  });

  it('gives two uploads in the same second different names', () => {
    expect(buildStoredFileName('a.xlsx', now)).not.toBe(buildStoredFileName('a.xlsx', now));
  });
});

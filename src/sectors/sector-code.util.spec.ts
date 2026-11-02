import { canBeSectorName, closestSector, normalizeSectorCode } from './sector-code.util';

describe('normalizeSectorCode', () => {
  it.each([
    [' npf ', 'NPF'],
    ['lagos   state', 'LAGOS STATE'],
    ['Custom', 'CUSTOMS'],
    ['CUSTOMS', 'CUSTOMS'],
  ])('%s becomes %s', (raw, code) => {
    expect(normalizeSectorCode(raw)).toBe(code);
  });
});

describe('closestSector', () => {
  const existing = ['NPF', 'NSCDC', 'IMMIGRATION', 'CORRECTIONAL', 'CUSTOMS', 'LASG'];

  it.each([
    ['NFP', 'NPF'],
    ['IMIGRATION', 'IMMIGRATION'],
    ['CUSTOM S', 'CUSTOMS'],
  ])('flags %s as a likely typo of %s', (code, match) => {
    expect(closestSector(code, existing)).toBe(match);
  });

  it.each(['FRSC', 'NDLEA', 'KASG STAFF', 'NAVY'])('treats %s as genuinely new', (code) => {
    expect(closestSector(code, existing)).toBeNull();
  });
});

describe('canBeSectorName', () => {
  it.each(['Sheet1', 'sheet 2', 'SHEET', 'Data', 'Export', 'Summary', 'Notes', 'Table1', 'Copy (2)'])('refuses %s', (name) => {
    expect(canBeSectorName(name)).toBe(false);
  });

  it.each(['FRSC', 'Lagos State', 'NDLEA', 'Kaduna State Civil Service'])('allows %s', (name) => {
    expect(canBeSectorName(name)).toBe(true);
  });
});

import { auditChanges } from './audit-changes.util';

describe('auditChanges', () => {
  it('lists only the fields that changed', () => {
    expect(auditChanges({ a: 1, b: 'x' }, { a: 2, b: 'x' }, ['a', 'b'])).toEqual({ a: { from: 1, to: 2 } });
  });

  it('ignores fields it was not asked about', () => {
    expect(auditChanges({ a: 1, secret: 'old' }, { a: 1, secret: 'new' }, ['a'])).toEqual({});
  });

  it('compares decimals by value', () => {
    const decimal = (value: string) => ({ toString: () => value });
    expect(auditChanges({ v: decimal('2.5') }, { v: decimal('2.5') }, ['v'])).toEqual({});
    expect(auditChanges({ v: decimal('2.5') }, { v: decimal('3') }, ['v'])).toEqual({ v: { from: '2.5', to: '3' } });
  });

  it('treats undefined and null as the same, and compares arrays and objects by content', () => {
    expect(auditChanges({ v: undefined as string | undefined | null }, { v: null }, ['v'])).toEqual({});
    expect(auditChanges({ v: [{ rate: 1 }] }, { v: [{ rate: 1 }] }, ['v'])).toEqual({});
    expect(auditChanges({ v: [{ rate: 1 }] }, { v: [{ rate: 2 }] }, ['v'])).toEqual({
      v: { from: [{ rate: 1 }], to: [{ rate: 2 }] },
    });
  });
});

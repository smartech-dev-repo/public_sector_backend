import { isUniqueConstraintError } from './is-unique-constraint-error.util';

describe('isUniqueConstraintError', () => {
  it('returns true for a Prisma P2002 error', () => {
    expect(isUniqueConstraintError({ code: 'P2002' })).toBe(true);
  });

  it('returns false for a different Prisma error code', () => {
    expect(isUniqueConstraintError({ code: 'P2025' })).toBe(false);
  });

  it('returns false for null, undefined, and non-object values', () => {
    expect(isUniqueConstraintError(null)).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError('P2002')).toBe(false);
  });
});

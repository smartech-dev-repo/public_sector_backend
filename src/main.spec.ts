import { resolveCorsOrigin } from './main';

describe('resolveCorsOrigin', () => {
  const originalEnv = process.env.CORS_ORIGINS;

  afterEach(() => {
    process.env.CORS_ORIGINS = originalEnv;
  });

  it('returns false when CORS_ORIGINS is unset', () => {
    delete process.env.CORS_ORIGINS;
    expect(resolveCorsOrigin()).toBe(false);
  });

  it('returns false when CORS_ORIGINS is empty', () => {
    process.env.CORS_ORIGINS = '   ';
    expect(resolveCorsOrigin()).toBe(false);
  });

  it('returns true for the wildcard value', () => {
    process.env.CORS_ORIGINS = '*';
    expect(resolveCorsOrigin()).toBe(true);
  });

  it('splits a comma-separated list into trimmed origins', () => {
    process.env.CORS_ORIGINS = 'https://admin.example.com, https://app.example.com';
    expect(resolveCorsOrigin()).toEqual(['https://admin.example.com', 'https://app.example.com']);
  });

  it('drops empty entries caused by trailing commas', () => {
    process.env.CORS_ORIGINS = 'https://admin.example.com,,';
    expect(resolveCorsOrigin()).toEqual(['https://admin.example.com']);
  });
});

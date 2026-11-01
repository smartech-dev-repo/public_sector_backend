import { resolveCorsOrigin, resolveTrustProxyHops } from './main';

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

describe('resolveTrustProxyHops', () => {
  const originalEnv = process.env.TRUST_PROXY_HOPS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = originalEnv;
  });

  it('trusts no proxy unless told to', () => {
    delete process.env.TRUST_PROXY_HOPS;
    expect(resolveTrustProxyHops()).toBe(0);
  });

  it('reads the configured number of proxies', () => {
    process.env.TRUST_PROXY_HOPS = '2';
    expect(resolveTrustProxyHops()).toBe(2);
  });

  it.each(['true', '-1', '1.5'])('refuses %s at startup', (value) => {
    process.env.TRUST_PROXY_HOPS = value;
    expect(() => resolveTrustProxyHops()).toThrow('TRUST_PROXY_HOPS');
  });
});

import * as express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import {
  BACKOFFICE_CLIENT_IP_HEADER,
  BACKOFFICE_SECRET_HEADER,
  ClientIpOptions,
  clientIp,
  resolveBackofficeProxySecret,
  resolveClientIpHeader,
} from './client-ip.middleware';

const SECRET = 'a'.repeat(40);
const VOUCHED = {
  [BACKOFFICE_SECRET_HEADER]: SECRET,
  [BACKOFFICE_CLIENT_IP_HEADER]: '203.0.113.7',
};

/** Runs a real Express app so req.ip comes from Express itself, as in production. */
async function startApp(options: ClientIpOptions) {
  const app = express();
  app.use(clientIp(options));
  app.get('*', (req, res) => {
    res.json({
      ip: req.ip,
      leaked: [
        req.headers[BACKOFFICE_SECRET_HEADER],
        req.headers[BACKOFFICE_CLIENT_IP_HEADER],
      ].filter(Boolean),
    });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}

describe('clientIp', () => {
  let server: Server;
  let url: string;

  afterEach(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  const call = async (headers: Record<string, string>, path = '/x') =>
    (await (await fetch(url + path, { headers })).json()) as {
      ip: string;
      leaked: string[];
    };

  describe('back office vouching', () => {
    it('uses the vouched IP when the secret matches, and removes both headers', async () => {
      ({ server, url } = await startApp({ backofficeSecret: SECRET }));
      expect(await call(VOUCHED)).toEqual({ ip: '203.0.113.7', leaked: [] });
    });

    it('ignores the IP when the secret is wrong', async () => {
      ({ server, url } = await startApp({ backofficeSecret: SECRET }));
      const body = await call({
        ...VOUCHED,
        [BACKOFFICE_SECRET_HEADER]: 'b'.repeat(40),
      });
      expect(body.ip).not.toBe('203.0.113.7');
      expect(body.leaked).toEqual([]);
    });

    it('ignores the IP when no secret is configured', async () => {
      ({ server, url } = await startApp({}));
      expect((await call(VOUCHED)).ip).not.toBe('203.0.113.7');
    });

    it('ignores a value that is not an IP address', async () => {
      ({ server, url } = await startApp({ backofficeSecret: SECRET }));
      const body = await call({
        ...VOUCHED,
        [BACKOFFICE_CLIENT_IP_HEADER]: 'evil.example.com',
      });
      expect(body.ip).not.toBe('evil.example.com');
    });
  });

  describe('edge client-IP header', () => {
    it('uses the configured header', async () => {
      ({ server, url } = await startApp({
        clientIpHeader: 'cf-connecting-ip',
      }));
      expect((await call({ 'cf-connecting-ip': '198.51.100.4' })).ip).toBe(
        '198.51.100.4',
      );
    });

    it('prefers the back office vouched IP over the edge header', async () => {
      ({ server, url } = await startApp({
        backofficeSecret: SECRET,
        clientIpHeader: 'cf-connecting-ip',
      }));
      const body = await call({
        ...VOUCHED,
        'cf-connecting-ip': '198.51.100.4',
      });
      expect(body.ip).toBe('203.0.113.7');
    });

    it('ignores the header when none is configured', async () => {
      ({ server, url } = await startApp({}));
      expect((await call({ 'cf-connecting-ip': '198.51.100.4' })).ip).not.toBe(
        '198.51.100.4',
      );
    });

    it('falls back and warns, at most every 10 minutes, when the header is missing', async () => {
      const warn = jest.fn();
      let clock = 0;
      ({ server, url } = await startApp({
        clientIpHeader: 'cf-connecting-ip',
        warn,
        now: () => clock,
      }));
      expect((await call({})).ip).toMatch(/127\.0\.0\.1/);
      await call({ 'cf-connecting-ip': 'not-an-ip' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/update CLIENT_IP_HEADER/);
      clock += 10 * 60 * 1000;
      await call({});
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('does not warn for health checks', async () => {
      const warn = jest.fn();
      ({ server, url } = await startApp({
        clientIpHeader: 'cf-connecting-ip',
        warn,
      }));
      await call({}, '/health');
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('resolveBackofficeProxySecret', () => {
  const original = process.env.BACKOFFICE_PROXY_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.BACKOFFICE_PROXY_SECRET;
    else process.env.BACKOFFICE_PROXY_SECRET = original;
  });

  it('is undefined when unset', () => {
    delete process.env.BACKOFFICE_PROXY_SECRET;
    expect(resolveBackofficeProxySecret()).toBeUndefined();
  });

  it('rejects a short secret', () => {
    process.env.BACKOFFICE_PROXY_SECRET = 'short';
    expect(() => resolveBackofficeProxySecret()).toThrow(/at least 32/);
  });

  it('returns a long enough secret', () => {
    process.env.BACKOFFICE_PROXY_SECRET = SECRET;
    expect(resolveBackofficeProxySecret()).toBe(SECRET);
  });
});

describe('resolveClientIpHeader', () => {
  const original = process.env.CLIENT_IP_HEADER;
  afterEach(() => {
    if (original === undefined) delete process.env.CLIENT_IP_HEADER;
    else process.env.CLIENT_IP_HEADER = original;
  });

  it('is undefined when unset', () => {
    delete process.env.CLIENT_IP_HEADER;
    expect(resolveClientIpHeader()).toBeUndefined();
  });

  it('lower-cases a header name', () => {
    process.env.CLIENT_IP_HEADER = ' CF-Connecting-IP ';
    expect(resolveClientIpHeader()).toBe('cf-connecting-ip');
  });

  it('rejects anything that is not a single header name', () => {
    process.env.CLIENT_IP_HEADER = 'cf-connecting-ip, x-real-ip';
    expect(() => resolveClientIpHeader()).toThrow(/single header name/);
  });
});

import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import { outboundFetch } from './outbound-fetch.util';

describe('outboundFetch', () => {
  let server: Server;
  let base: string;
  let hits: { path: string; headers: IncomingHttpHeaders }[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push({ path: req.url ?? '', headers: req.headers });
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/leak' });
        return res.end();
      }
      if (req.url === '/slow')
        return void setTimeout(() => res.end('late'), 1000);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    hits = [];
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns the response for a normal answer', async () => {
    const res = await outboundFetch(`${base}/ok`, {
      headers: { Authorization: 'secret' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses to follow a redirect, so secret headers are sent only once', async () => {
    await expect(
      outboundFetch(`${base}/redirect`, {
        headers: { Authorization: 'secret' },
      }),
    ).rejects.toThrow(/redirect \(302\); not followed/);
    expect(hits.map((h) => h.path)).toEqual(['/redirect']);
  });

  it('gives up after the timeout', async () => {
    await expect(
      outboundFetch(`${base}/slow`, { timeoutMs: 100 }),
    ).rejects.toThrow(/abort|timeout/i);
  });
});

import { ConfigService } from '@nestjs/config';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FaceEngineUnavailableError } from './face-verification-provider.interface';
import { PythonFaceVerificationProvider } from './python-face-verification.provider';

/**
 * Runs the provider against small Node scripts standing in for compare_faces.py, so the
 * process handling (stdin/stdout contract, exit codes, timeout, environment, concurrency) is
 * tested without Python. compare_faces.py itself is tested by face-match/test_compare_faces.py.
 */
describe('PythonFaceVerificationProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'face-match-spec-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.FACE_MATCH_SPEC_SECRET;
  });

  function stub(body: string): string {
    const path = join(dir, `stub-${Math.random().toString(36).slice(2)}.js`);
    writeFileSync(
      path,
      `const input = []; process.stdin.on('data', (c) => input.push(c)); process.stdin.on('end', () => {
        const raw = Buffer.concat(input).toString(); const args = process.argv.slice(2);
        ${body}
      });`,
    );
    return path;
  }

  function provider(script: string, extra: Record<string, string> = {}) {
    const values: Record<string, string> = {
      FACE_MATCH_PYTHON: process.execPath,
      FACE_MATCH_SCRIPT: script,
      FACE_MATCH_MODELS_DIR: dir,
      ...extra,
    };
    return new PythonFaceVerificationProvider({
      get: (key: string) => values[key],
    } as unknown as ConfigService);
  }

  it('sends the photos as base64 on stdin and returns the scores', async () => {
    const script = stub(`
      const req = JSON.parse(raw);
      require('fs').writeFileSync(process.env.FACE_MATCH_MODELS_DIR + '/request.json', raw);
      console.log(JSON.stringify({ results: { bvn: { score: 0.61 }, nin: { error: 'NO_FACE' } } }));
    `);

    const result = await provider(script).compare(Buffer.from('selfie'), {
      bvn: Buffer.from('b'),
      nin: Buffer.from('n'),
    });

    expect(result).toEqual({
      results: { bvn: { score: 0.61 }, nin: { error: 'NO_FACE' } },
    });
    expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))).toEqual(
      {
        candidate: Buffer.from('selfie').toString('base64'),
        references: {
          bvn: Buffer.from('b').toString('base64'),
          nin: Buffer.from('n').toString('base64'),
        },
      },
    );
  });

  it("doesn't pass the API's environment to the process", async () => {
    process.env.FACE_MATCH_SPEC_SECRET = 'do-not-leak';
    const script = stub(`
      require('fs').writeFileSync(process.env.FACE_MATCH_MODELS_DIR + '/env.json', JSON.stringify(Object.keys(process.env)));
      console.log(JSON.stringify({ results: { bvn: { score: 0.5 } } }));
    `);

    await provider(script).compare(Buffer.from('x'), { bvn: Buffer.from('b') });

    const keys = JSON.parse(
      readFileSync(join(dir, 'env.json'), 'utf8'),
    ) as string[];
    expect(keys).not.toContain('FACE_MATCH_SPEC_SECRET');
    expect(keys).toEqual(
      expect.arrayContaining(['PATH', 'FACE_MATCH_MODELS_DIR']),
    );
  });

  it('returns a problem with the photo itself as a result, not an error', async () => {
    const script = stub(
      `console.log(JSON.stringify({ error: 'MULTIPLE_FACES_IN_CANDIDATE' }));`,
    );
    await expect(
      provider(script).compare(Buffer.from('x'), { bvn: Buffer.from('b') }),
    ).resolves.toEqual({
      error: 'MULTIPLE_FACES_IN_CANDIDATE',
    });
  });

  it.each([
    [
      'a non-zero exit',
      `process.stderr.write('Traceback: boom'); process.exit(1);`,
    ],
    ['output that is not JSON', `console.log('hello');`],
    [
      'a missing reference result',
      `console.log(JSON.stringify({ results: {} }));`,
    ],
    [
      'a score out of range',
      `console.log(JSON.stringify({ results: { bvn: { score: 7 } } }));`,
    ],
    [
      'an unknown error code',
      `console.log(JSON.stringify({ error: 'SOMETHING_ELSE' }));`,
    ],
  ])('treats %s as the engine being unavailable', async (_case, body) => {
    await expect(
      provider(stub(body)).compare(Buffer.from('x'), { bvn: Buffer.from('b') }),
    ).rejects.toBeInstanceOf(FaceEngineUnavailableError);
  });

  it('kills a comparison that takes too long', async () => {
    const script = stub(`setTimeout(() => console.log('{}'), 5000);`);
    const started = Date.now();
    await expect(
      provider(script, { FACE_MATCH_TIMEOUT_MS: '300' }).compare(
        Buffer.from('x'),
        { bvn: Buffer.from('b') },
      ),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports a missing interpreter as unavailable', async () => {
    const missing = provider(stub(''), {
      FACE_MATCH_PYTHON: join(dir, 'no-such-python'),
    });
    await expect(
      missing.compare(Buffer.from('x'), { bvn: Buffer.from('b') }),
    ).rejects.toThrow(/could not start/);
    await expect(missing.status()).resolves.toEqual({
      available: false,
      detail: expect.stringMatching(/could not start/),
    });
  });

  it('runs no more comparisons at once than FACE_MATCH_CONCURRENCY', async () => {
    const script = stub(`
      const fs = require('fs'); const log = process.env.FACE_MATCH_MODELS_DIR + '/log';
      fs.appendFileSync(log, 'start\\n');
      setTimeout(() => { fs.appendFileSync(log, 'end\\n'); console.log(JSON.stringify({ results: { bvn: { score: 0.5 } } })); }, 150);
    `);
    const engine = provider(script, { FACE_MATCH_CONCURRENCY: '1' });

    await Promise.all(
      [1, 2, 3].map(() =>
        engine.compare(Buffer.from('x'), { bvn: Buffer.from('b') }),
      ),
    );

    expect(readFileSync(join(dir, 'log'), 'utf8').trim().split('\n')).toEqual([
      'start',
      'end',
      'start',
      'end',
      'start',
      'end',
    ]);
  });

  describe('status', () => {
    it('runs the script with --check and reports the OpenCV version', async () => {
      const script = stub(`
        require('fs').appendFileSync(process.env.FACE_MATCH_MODELS_DIR + '/checks', 'x');
        if (args[0] === '--check') console.log(JSON.stringify({ ok: true, opencv: '4.12.0' })); else process.exit(3);
      `);
      const engine = provider(script);

      await expect(engine.status()).resolves.toEqual({
        available: true,
        detail: 'OpenCV 4.12.0',
      });
      await engine.status();
      // Cached for a minute.
      expect(readFileSync(join(dir, 'checks'), 'utf8')).toBe('x');
    });

    it("gives the script's last error line when the check fails", async () => {
      const script = stub(
        `process.stderr.write('loading\\nFileNotFoundError: model file missing'); process.exit(1);`,
      );
      await expect(provider(script).status()).resolves.toEqual({
        available: false,
        detail: 'FileNotFoundError: model file missing',
      });
    });
  });
});

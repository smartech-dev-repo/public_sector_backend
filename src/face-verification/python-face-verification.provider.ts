import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { resolve } from 'path';
import {
  FaceComparison,
  FaceEngineStatus,
  FaceEngineUnavailableError,
  FaceVerificationProvider,
} from './face-verification-provider.interface';

/** face-match/compare_faces.py, from both src/face-verification (tests) and dist/face-verification. */
const DEFAULT_SCRIPT = resolve(__dirname, '../../face-match/compare_faces.py');
const COMPARE_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const STATUS_CACHE_MS = 60_000;

const CANDIDATE_PROBLEMS = new Set([
  'NO_FACE_IN_CANDIDATE',
  'MULTIPLE_FACES_IN_CANDIDATE',
  'UNREADABLE_CANDIDATE',
]);
const REFERENCE_PROBLEMS = new Set(['NO_FACE', 'UNREADABLE_IMAGE']);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Compares faces with face-match/compare_faces.py (OpenCV), one Python process per comparison.
 *
 * Settings, all optional:
 *   FACE_MATCH_PYTHON        interpreter, default "python3"
 *   FACE_MATCH_SCRIPT        path to compare_faces.py
 *   FACE_MATCH_MODELS_DIR    model files, default face-match/models
 *   FACE_MATCH_CONCURRENCY   comparisons run at once, default 2 (each is CPU-bound, ~0.3 s)
 *   FACE_MATCH_TIMEOUT_MS    longest a comparison may take, default 30000
 *
 * The process gets only PATH and the models directory from the environment, never the API's
 * secrets.
 */
@Injectable()
export class PythonFaceVerificationProvider implements FaceVerificationProvider {
  private readonly logger = new Logger(PythonFaceVerificationProvider.name);
  private readonly python: string;
  private readonly script: string;
  private readonly modelsDir?: string;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private cachedStatus?: { status: FaceEngineStatus; at: number };

  constructor(config: ConfigService) {
    this.python = config.get<string>('FACE_MATCH_PYTHON') || 'python3';
    this.script = config.get<string>('FACE_MATCH_SCRIPT') || DEFAULT_SCRIPT;
    this.modelsDir = config.get<string>('FACE_MATCH_MODELS_DIR') || undefined;
    const concurrency = Number(config.get<string>('FACE_MATCH_CONCURRENCY'));
    this.concurrency =
      Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 2;
    const timeoutMs = Number(config.get<string>('FACE_MATCH_TIMEOUT_MS'));
    this.timeoutMs =
      Number.isInteger(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : COMPARE_TIMEOUT_MS;
  }

  async compare(
    candidate: Buffer,
    references: Record<string, Buffer>,
  ): Promise<FaceComparison> {
    const input = JSON.stringify({
      candidate: candidate.toString('base64'),
      references: Object.fromEntries(
        Object.entries(references).map(([name, photo]) => [
          name,
          photo.toString('base64'),
        ]),
      ),
    });
    const result = await this.withSlot(() =>
      this.run([], input, this.timeoutMs),
    );
    if (result.code !== 0) {
      throw this.unavailable(`exited with code ${result.code}`, result.stderr);
    }
    return this.parseComparison(result.stdout, Object.keys(references));
  }

  async status(): Promise<FaceEngineStatus> {
    if (
      this.cachedStatus &&
      Date.now() - this.cachedStatus.at < STATUS_CACHE_MS
    ) {
      return this.cachedStatus.status;
    }
    let status: FaceEngineStatus;
    try {
      const result = await this.run(
        ['--check'],
        '',
        Math.min(CHECK_TIMEOUT_MS, this.timeoutMs),
      );
      const parsed =
        result.code === 0
          ? (JSON.parse(result.stdout) as { ok?: boolean; opencv?: string })
          : null;
      status = parsed?.ok
        ? { available: true, detail: `OpenCV ${parsed.opencv}` }
        : {
            available: false,
            detail:
              lastLine(result.stderr) || `exited with code ${result.code}`,
          };
    } catch (error) {
      status = {
        available: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.cachedStatus = { status, at: Date.now() };
    return status;
  }

  private parseComparison(stdout: string, names: string[]): FaceComparison {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw this.unavailable('returned output that is not JSON', '');
    }
    const body = parsed as {
      error?: unknown;
      results?: Record<string, { score?: unknown; error?: unknown }>;
    };
    if (typeof body.error === 'string' && CANDIDATE_PROBLEMS.has(body.error)) {
      return { error: body.error as 'NO_FACE_IN_CANDIDATE' };
    }
    const results: Record<
      string,
      { score: number } | { error: 'NO_FACE' | 'UNREADABLE_IMAGE' }
    > = {};
    for (const name of names) {
      const entry = body.results?.[name];
      if (
        typeof entry?.score === 'number' &&
        entry.score >= 0 &&
        entry.score <= 1
      ) {
        results[name] = { score: entry.score };
      } else if (
        typeof entry?.error === 'string' &&
        REFERENCE_PROBLEMS.has(entry.error)
      ) {
        results[name] = { error: entry.error as 'NO_FACE' };
      } else {
        throw this.unavailable(`returned no result for "${name}"`, '');
      }
    }
    return { results };
  }

  private unavailable(
    problem: string,
    stderr: string,
  ): FaceEngineUnavailableError {
    const detail = lastLine(stderr);
    this.logger.error(
      `[face-match] comparison ${problem}${detail ? `: ${detail}` : ''}`,
    );
    this.cachedStatus = undefined;
    return new FaceEngineUnavailableError(`Face comparison ${problem}`);
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) {
      await new Promise<void>((ready) => this.waiting.push(ready));
    }
    this.running += 1;
    try {
      return await task();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  private run(
    args: string[],
    input: string,
    timeoutMs: number,
  ): Promise<RunResult> {
    return new Promise((resolveRun, reject) => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
      };
      if (this.modelsDir) env.FACE_MATCH_MODELS_DIR = this.modelsDir;

      const child = spawn(this.python, [this.script, ...args], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let failure: Error | undefined;

      const fail = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () =>
          fail(
            new FaceEngineUnavailableError(
              `Face comparison timed out after ${timeoutMs} ms`,
            ),
          ),
        timeoutMs,
      );

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_STDOUT_BYTES)
          fail(
            new FaceEngineUnavailableError('Face comparison output too large'),
          );
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString();
      });
      child.on('error', (error) =>
        fail(
          new FaceEngineUnavailableError(
            `Face comparison could not start ${this.python}: ${error.message}`,
          ),
        ),
      );
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) {
          this.logger.error(`[face-match] ${failure.message}`);
          this.cachedStatus = undefined;
          reject(failure);
        } else {
          resolveRun({ code, stdout, stderr });
        }
      });
      // The process may exit before reading stdin (e.g. missing models); that's reported by its
      // exit code, not by this write.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    });
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.slice(0, 300) ?? '';
}

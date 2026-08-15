/**
 * OpenSCAD process execution.
 *
 * This is the only place in the package that starts a process, and the rules
 * are absolute:
 *
 *   - The binary is either an operator-configured path or one of a fixed list
 *     of well-known locations. It is never derived from a request.
 *   - Arguments are passed as an array with `shell: false`. There is no string
 *     to quote wrongly, so there is nothing to inject into.
 *   - Every run is bounded three ways: wall clock, captured output per stream,
 *     and how many can run at once.
 *   - The child gets a minimal environment, no stdin, and no console window.
 *
 * There is no "run this command" entry point, and there must never be one:
 * every caller names an operation, and this module builds the argv.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import { CrealityError } from '../errors.js';

export type SpawnFn = typeof nodeSpawn;

export interface OpenScadRunOptions {
  /** Argument vector after the binary. Never a shell string. */
  readonly args: readonly string[];
  /** Working directory; callers pass the project's build sandbox. */
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface OpenScadRunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** True when output hit {@link ModelConfig.maxOutputBytes} and was clipped. */
  readonly truncated: boolean;
}

export interface OpenScadStatus {
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
  /** Populated when `available` is false: what to install, and how to point at it. */
  readonly reason?: string;
  readonly searched?: readonly string[];
}

/** The seam the service depends on; tests substitute a fake. */
export interface OpenScadRunner {
  status(): Promise<OpenScadStatus>;
  run(options: OpenScadRunOptions): Promise<OpenScadRunResult>;
}

/** Grace period between asking a hung child to stop and killing it. */
const KILL_GRACE_MS = 2_000;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_PATTERN = /OpenSCAD version\s+(\S+)/i;

/**
 * Candidate binaries, in preference order.
 *
 * On Windows `openscad.com` is the console front-end: `openscad.exe` is a GUI
 * subsystem binary that detaches from the console, so its diagnostics never
 * reach our pipes. Prefer `.com`, fall back to `.exe`.
 */
export function defaultCandidates(platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === 'win32') {
    return [
      'openscad.com',
      'openscad.exe',
      'C:\\Program Files\\OpenSCAD\\openscad.com',
      'C:\\Program Files\\OpenSCAD\\openscad.exe',
      'C:\\Program Files (x86)\\OpenSCAD\\openscad.com',
    ];
  }
  if (platform === 'darwin') {
    return [
      'openscad',
      '/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD',
      '/opt/homebrew/bin/openscad',
      '/usr/local/bin/openscad',
    ];
  }
  return ['openscad', '/usr/bin/openscad', '/usr/local/bin/openscad', '/snap/bin/openscad'];
}

/**
 * A minimal environment for the child.
 *
 * OpenSCAD needs enough to find its own libraries and a temp directory, and
 * nothing else. Notably absent: the parent's full env, which on an agent host
 * routinely holds API keys. `OPENSCADPATH` is excluded deliberately — it would
 * let an operator-set variable pull library code into every render.
 */
export function childEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const keep = [
    'PATH',
    'Path',
    'SystemRoot',
    'SystemDrive',
    'WINDIR',
    'windir',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'DISPLAY',
    'XDG_RUNTIME_DIR',
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Bound how many processes run at once; the rest wait their turn. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      const next = this.#waiting.shift();
      if (next !== undefined) next();
    }
  }
}

/** Collects a stream up to `maxBytes`, then keeps counting but stops storing. */
class BoundedBuffer {
  readonly #chunks: Buffer[] = [];
  readonly #maxBytes: number;
  #stored = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  push(chunk: Buffer): void {
    const remaining = this.#maxBytes - this.#stored;
    if (remaining <= 0) {
      this.#truncated = true;
      return;
    }
    if (chunk.byteLength > remaining) {
      this.#chunks.push(chunk.subarray(0, remaining));
      this.#stored = this.#maxBytes;
      this.#truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#stored += chunk.byteLength;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  text(): string {
    const text = Buffer.concat(this.#chunks).toString('utf8');
    return this.#truncated ? `${text}\n…[output truncated at ${this.#maxBytes} bytes]` : text;
  }
}

export interface ExecuteOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly spawn?: SpawnFn;
  readonly env?: Record<string, string>;
}

/**
 * Run a binary with an argument array and bounded time and output.
 *
 * Resolves for any process outcome, including a non-zero exit — a model with a
 * syntax error is data, not an exception. It rejects only when the process
 * could not be started at all.
 */
export async function execute(
  binary: string,
  args: readonly string[],
  options: ExecuteOptions,
): Promise<OpenScadRunResult> {
  const spawnFn = options.spawn ?? nodeSpawn;
  const startedAt = Date.now();

  return await new Promise<OpenScadRunResult>((resolve, reject) => {
    const spawnOptions: SpawnOptions = {
      cwd: options.cwd,
      env: options.env ?? childEnvironment(),
      // Never true. A shell would reintroduce quoting and injection.
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    let child: ChildProcess;
    try {
      child = spawnFn(binary, [...args], spawnOptions);
    } catch (error) {
      reject(
        new CrealityError('TOOL_UNAVAILABLE', `Could not start "${binary}".`, { cause: error }),
      );
      return;
    }

    const stdout = new BoundedBuffer(options.maxOutputBytes);
    const stderr = new BoundedBuffer(options.maxOutputBytes);
    let timedOut = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A child that ignores SIGTERM still has to go.
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL');
      }, KILL_GRACE_MS).unref();
    }, options.timeoutMs);
    killTimer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(
        new CrealityError('TOOL_UNAVAILABLE', `Could not start "${binary}": ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        ok: !timedOut && code === 0,
        exitCode: code,
        signal: signal ?? null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - startedAt,
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

export interface CliOpenScadRunnerOptions {
  readonly binaryPath?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxConcurrency: number;
  readonly spawn?: SpawnFn;
  readonly platform?: NodeJS.Platform;
  readonly env?: Record<string, string>;
}

/** The real runner: probes for a binary once, then executes bounded renders. */
export class CliOpenScadRunner implements OpenScadRunner {
  readonly #options: CliOpenScadRunnerOptions;
  readonly #semaphore: Semaphore;
  #probe: Promise<OpenScadStatus> | undefined;

  constructor(options: CliOpenScadRunnerOptions) {
    this.#options = options;
    this.#semaphore = new Semaphore(options.maxConcurrency);
  }

  /** Detection is cached: probing costs a process spawn per candidate. */
  async status(): Promise<OpenScadStatus> {
    this.#probe ??= this.#detect();
    return await this.#probe;
  }

  /** Forget a cached probe, e.g. after the operator installs OpenSCAD. */
  reset(): void {
    this.#probe = undefined;
  }

  async run(options: OpenScadRunOptions): Promise<OpenScadRunResult> {
    const status = await this.status();
    if (!status.available || status.path === undefined) {
      throw openscadUnavailable(status);
    }
    const binary = status.path;
    return await this.#semaphore.run(
      async () =>
        await execute(binary, options.args, {
          cwd: options.cwd,
          timeoutMs: options.timeoutMs ?? this.#options.timeoutMs,
          maxOutputBytes: this.#options.maxOutputBytes,
          ...(this.#options.spawn === undefined ? {} : { spawn: this.#options.spawn }),
          ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
        }),
    );
  }

  async #detect(): Promise<OpenScadStatus> {
    const configured = this.#options.binaryPath?.trim();
    const candidates =
      configured === undefined || configured === ''
        ? defaultCandidates(this.#options.platform ?? process.platform)
        : [configured];

    for (const candidate of candidates) {
      const probed = await this.#probeCandidate(candidate);
      if (probed !== undefined) return probed;
    }

    return {
      available: false,
      searched: candidates,
      reason:
        configured === undefined || configured === ''
          ? `OpenSCAD was not found. Tried: ${candidates.join(', ')}. Install it from ` +
            'https://openscad.org/downloads.html, or set CREALITY_OPENSCAD_PATH to the binary.'
          : `OpenSCAD was not runnable at the configured path "${configured}" ` +
            '(CREALITY_OPENSCAD_PATH). Check the path and that the file is executable.',
    };
  }

  async #probeCandidate(candidate: string): Promise<OpenScadStatus | undefined> {
    try {
      const result = await execute(candidate, ['--version'], {
        cwd: process.cwd(),
        timeoutMs: Math.min(VERSION_TIMEOUT_MS, this.#options.timeoutMs),
        maxOutputBytes: 8 * 1024,
        ...(this.#options.spawn === undefined ? {} : { spawn: this.#options.spawn }),
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
      });
      if (!result.ok) return undefined;
      // OpenSCAD writes its banner to stderr on most builds, stdout on some.
      const version = VERSION_PATTERN.exec(`${result.stderr}\n${result.stdout}`)?.[1];
      return {
        available: true,
        path: candidate,
        ...(version === undefined ? {} : { version }),
      };
    } catch {
      // ENOENT for this candidate; try the next.
      return undefined;
    }
  }
}

/** The error every caller should surface when OpenSCAD is missing. */
export function openscadUnavailable(status: OpenScadStatus): CrealityError {
  return new CrealityError(
    'TOOL_UNAVAILABLE',
    status.reason ??
      'OpenSCAD is not available. Install it from https://openscad.org/downloads.html, ' +
        'or set CREALITY_OPENSCAD_PATH to the binary.',
    {
      details: {
        tool: 'openscad',
        ...(status.searched === undefined ? {} : { searched: status.searched }),
        installUrl: 'https://openscad.org/downloads.html',
        envKey: 'CREALITY_OPENSCAD_PATH',
      },
    },
  );
}

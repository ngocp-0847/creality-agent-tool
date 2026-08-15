/**
 * Process-execution tests.
 *
 * OpenSCAD is not installed on CI, and these tests must not need it. Two
 * substitutes are used: `process.execPath` (Node itself) as a real child
 * process, so the bounds on time, output and argument handling are proven
 * against a real spawn; and a fake `spawn` for detection, where the point is
 * which candidates are tried and what is concluded.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import {
  CliOpenScadRunner,
  Semaphore,
  childEnvironment,
  defaultCandidates,
  execute,
  openscadUnavailable,
  type SpawnFn,
} from '../src/model/openscad.js';

const NODE = process.execPath;

function runNode(script: string, extraArgs: readonly string[] = [], timeoutMs = 15_000) {
  return execute(NODE, ['-e', script, ...extraArgs], {
    cwd: process.cwd(),
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });
}

interface FakeOutcome {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error;
}

/** A spawn that never starts a process, for detection tests. */
function fakeSpawn(
  handler: (binary: string, args: readonly string[]) => FakeOutcome,
  seen: { binary: string; args: readonly string[] }[] = [],
): SpawnFn {
  return ((binary: string, args: readonly string[]) => {
    seen.push({ binary, args });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child['stdout'] = stdout;
    child['stderr'] = stderr;
    child['kill'] = () => true;

    const outcome = handler(binary, args);
    setImmediate(() => {
      if (outcome.error) {
        child.emit('error', outcome.error);
        return;
      }
      if (outcome.stdout) stdout.write(outcome.stdout);
      if (outcome.stderr) stderr.write(outcome.stderr);
      setImmediate(() => child.emit('close', outcome.code ?? 0, null));
    });
    return child;
  }) as unknown as SpawnFn;
}

describe('execute', () => {
  it('returns stdout, stderr and a zero exit for a successful run', async () => {
    const result = await runNode('process.stdout.write("out"); process.stderr.write("err");');
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.ok(result.durationMs >= 0);
  });

  it('reports a non-zero exit as data, not as a thrown error', async () => {
    const result = await runNode('process.stderr.write("ERROR: syntax"); process.exit(3);');
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /ERROR: syntax/);
  });

  it('passes arguments as a vector, so shell metacharacters stay literal', async () => {
    const hostile = ['&& echo pwned', '; rm -rf /', '$(whoami)', '`id`', '| cat /etc/passwd', 'a b'];
    const result = await runNode(
      'process.stdout.write(JSON.stringify(process.argv.slice(1)));',
      hostile,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), hostile);
  });

  it('truncates output beyond the cap instead of buffering without bound', async () => {
    const result = await execute(
      NODE,
      ['-e', 'process.stdout.write("x".repeat(200000));'],
      { cwd: process.cwd(), timeoutMs: 15_000, maxOutputBytes: 1024 },
    );
    assert.equal(result.truncated, true);
    assert.ok(result.stdout.length < 1024 + 100, 'stored output should stay near the cap');
    assert.match(result.stdout, /output truncated at 1024 bytes/);
  });

  it('kills a process that outlives its deadline', async () => {
    const result = await runNode('setInterval(() => {}, 1000);', [], 500);
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(result.durationMs >= 400, `expected to wait for the deadline, got ${result.durationMs}`);
  });

  it('rejects with TOOL_UNAVAILABLE when the binary does not exist', async () => {
    await assert.rejects(
      () =>
        execute('definitely-not-a-real-binary-xyz', ['--version'], {
          cwd: process.cwd(),
          timeoutMs: 5_000,
          maxOutputBytes: 1024,
        }),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'TOOL_UNAVAILABLE');
        return true;
      },
    );
  });

  it('never asks the platform for a shell', async () => {
    const seen: { binary: string; args: readonly string[] }[] = [];
    const options: Record<string, unknown>[] = [];
    const spy = ((binary: string, args: readonly string[], opts: Record<string, unknown>) => {
      options.push(opts);
      return fakeSpawn(() => ({ code: 0 }), seen)(binary, args as string[]);
    }) as unknown as SpawnFn;

    await execute('openscad', ['-o', 'a.png', 'model.scad'], {
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
      spawn: spy,
    });

    assert.equal(options[0]?.['shell'], false);
    assert.equal(options[0]?.['windowsHide'], true);
    assert.deepEqual(seen[0]?.args, ['-o', 'a.png', 'model.scad']);
  });
});

describe('childEnvironment', () => {
  it('passes through only what a renderer needs', () => {
    const env = childEnvironment({
      PATH: '/usr/bin',
      HOME: '/home/user',
      LANG: 'en_US.UTF-8',
      CREALITY_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      OPENSCADPATH: '/tmp/evil-libraries',
    });
    assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/user', LANG: 'en_US.UTF-8' });
  });

  it('omits keys that are not set rather than passing undefined', () => {
    assert.deepEqual(childEnvironment({}), {});
  });
});

describe('Semaphore', () => {
  it('never runs more than the limit concurrently', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    assert.equal(peak, 2);
    assert.equal(semaphore.active, 0);
    assert.equal(semaphore.queued, 0);
  });

  it('releases its slot when a task throws', async () => {
    const semaphore = new Semaphore(1);
    await assert.rejects(() => semaphore.run(() => Promise.reject(new Error('boom'))));
    assert.equal(semaphore.active, 0);
    assert.equal(await semaphore.run(async () => 'recovered'), 'recovered');
  });
});

describe('defaultCandidates', () => {
  it('prefers the console front-end on Windows', () => {
    const candidates = defaultCandidates('win32');
    assert.equal(candidates[0], 'openscad.com');
    assert.ok(candidates.includes('openscad.exe'));
  });

  it('looks in the app bundle on macOS and on PATH elsewhere', () => {
    assert.ok(
      defaultCandidates('darwin').some((entry) => entry.includes('OpenSCAD.app')),
    );
    assert.equal(defaultCandidates('linux')[0], 'openscad');
  });
});

describe('CliOpenScadRunner detection', () => {
  it('uses the first candidate that answers --version, and parses it', async () => {
    const seen: { binary: string; args: readonly string[] }[] = [];
    const runner = new CliOpenScadRunner({
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'linux',
      spawn: fakeSpawn(
        (binary) =>
          binary === 'openscad'
            ? { code: 0, stderr: 'OpenSCAD version 2021.01\n' }
            : { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
        seen,
      ),
    });

    const status = await runner.status();
    assert.equal(status.available, true);
    assert.equal(status.path, 'openscad');
    assert.equal(status.version, '2021.01');
    assert.deepEqual(seen[0]?.args, ['--version']);
  });

  it('falls through failing candidates to a working one', async () => {
    const seen: { binary: string; args: readonly string[] }[] = [];
    const runner = new CliOpenScadRunner({
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'win32',
      spawn: fakeSpawn(
        (binary) =>
          binary === 'openscad.exe'
            ? { code: 0, stdout: 'OpenSCAD version 2024.01' }
            : { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
        seen,
      ),
    });

    const status = await runner.status();
    assert.equal(status.path, 'openscad.exe');
    assert.equal(status.version, '2024.01');
    assert.equal(seen[0]?.binary, 'openscad.com');
  });

  it('caches the probe rather than spawning per call', async () => {
    const seen: { binary: string; args: readonly string[] }[] = [];
    const runner = new CliOpenScadRunner({
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'linux',
      spawn: fakeSpawn(() => ({ code: 0, stderr: 'OpenSCAD version 2021.01' }), seen),
    });

    await runner.status();
    await runner.status();
    assert.equal(seen.length, 1);

    runner.reset();
    await runner.status();
    assert.equal(seen.length, 2);
  });

  it('only tries the configured path, and says so when it fails', async () => {
    const seen: { binary: string; args: readonly string[] }[] = [];
    const runner = new CliOpenScadRunner({
      binaryPath: '/opt/custom/openscad',
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'linux',
      spawn: fakeSpawn(() => ({ error: new Error('ENOENT') }), seen),
    });

    const status = await runner.status();
    assert.equal(status.available, false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.binary, '/opt/custom/openscad');
    assert.match(status.reason ?? '', /CREALITY_OPENSCAD_PATH/);
  });

  it('explains how to install when nothing is found', async () => {
    const runner = new CliOpenScadRunner({
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'linux',
      spawn: fakeSpawn(() => ({ error: new Error('ENOENT') })),
    });

    const status = await runner.status();
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /openscad\.org\/downloads/);
    assert.ok((status.searched ?? []).includes('openscad'));
  });

  it('refuses to run at all when detection failed', async () => {
    const runner = new CliOpenScadRunner({
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'linux',
      spawn: fakeSpawn(() => ({ error: new Error('ENOENT') })),
    });

    await assert.rejects(
      () => runner.run({ args: ['-o', 'x.png', 'm.scad'], cwd: process.cwd() }),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'TOOL_UNAVAILABLE');
        return true;
      },
    );
  });

  it('treats a candidate that exits non-zero as unusable', async () => {
    const runner = new CliOpenScadRunner({
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
      maxConcurrency: 1,
      platform: 'linux',
      spawn: fakeSpawn(() => ({ code: 127, stderr: 'not found' })),
    });
    assert.equal((await runner.status()).available, false);
  });
});

describe('openscadUnavailable', () => {
  it('carries install guidance in both message and details', () => {
    const error = openscadUnavailable({ available: false, searched: ['openscad'] });
    assert.equal(error.code, 'TOOL_UNAVAILABLE');
    assert.match(error.message, /openscad\.org\/downloads/);
    assert.equal(error.details?.['envKey'], 'CREALITY_OPENSCAD_PATH');
    assert.deepEqual(error.details?.['searched'], ['openscad']);
  });
});

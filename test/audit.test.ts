import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AuditLog, redactParams, type AuditRecord } from '../src/audit.js';
import { createAuditSink } from './helpers.js';

const FIXED_CLOCK = (): Date => new Date('2024-05-01T12:00:00.000Z');

describe('redactParams', () => {
  it('returns undefined for undefined', () => {
    assert.equal(redactParams(undefined), undefined);
  });

  it('replaces credential-bearing keys outright', () => {
    const result = redactParams({
      apiKey: 'super-secret',
      api_key: 'super-secret',
      'x-api-key': 'super-secret',
      token: 'tok_live_123',
      secret: 'shh',
      password: 'hunter2',
      authorization: 'Bearer abc',
      cookie: 'session=1',
    });
    for (const [key, value] of Object.entries(result ?? {})) {
      assert.equal(value, '[redacted]', `${key} should be redacted`);
    }
  });

  it('leaves ordinary values intact', () => {
    const result = redactParams({ filename: 'benchy.gcode', sizeBytes: 2048, startPrint: true });
    assert.deepEqual(result, { filename: 'benchy.gcode', sizeBytes: 2048, startPrint: true });
  });

  it('truncates long strings but records the original length', () => {
    const result = redactParams({ blob: 'x'.repeat(1000) });
    const blob = result?.['blob'];
    assert.equal(typeof blob, 'string');
    assert.match(blob as string, /…\[1000 chars\]$/);
    assert.ok((blob as string).length < 1000);
  });

  it('summarises binary payloads by length', () => {
    const result = redactParams({ bytes: new Uint8Array(4096) });
    assert.equal(result?.['bytes'], '[4096 bytes]');
  });

  it('caps long arrays', () => {
    const result = redactParams({ items: Array.from({ length: 50 }, (_, i) => i) });
    const items = result?.['items'] as unknown[];
    assert.equal(items.length, 21);
    assert.equal(items[20], '…[50 items]');
  });

  it('redacts nested credentials', () => {
    const result = redactParams({ outer: { inner: { apiKey: 'nope', keep: 1 } } });
    const outer = result?.['outer'] as Record<string, Record<string, unknown>>;
    assert.equal(outer['inner']?.['apiKey'], '[redacted]');
    assert.equal(outer['inner']?.['keep'], 1);
  });

  it('stops runaway nesting', () => {
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 12; i += 1) nested = { nested };
    const result = redactParams(nested);
    assert.match(JSON.stringify(result), /\[truncated\]/);
  });

  it('preserves null without crashing', () => {
    const result = redactParams({ nothing: null });
    assert.equal(result?.['nothing'], null);
  });
});

describe('AuditLog — recording', () => {
  it('stamps a record with the injected clock', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    const record = await log.record({
      action: 'start_print',
      outcome: 'applied',
      dryRun: false,
      summary: 'Start printing benchy.gcode',
    });
    assert.equal(record.ts, '2024-05-01T12:00:00.000Z');
    assert.equal(record.action, 'start_print');
    assert.equal(record.outcome, 'applied');
    assert.equal(record.dryRun, false);
  });

  it('redacts parameters on the way in', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    const record = await log.record({
      action: 'upload_gcode',
      outcome: 'applied',
      dryRun: false,
      summary: 'Upload',
      params: { filename: 'a.gcode', apiKey: 'leak-me' },
    });
    assert.equal(record.params?.['apiKey'], '[redacted]');
    assert.equal(record.params?.['filename'], 'a.gcode');
  });

  it('omits absent optional fields rather than writing undefined', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    const record = await log.record({
      action: 'pause_print',
      outcome: 'planned',
      dryRun: true,
      summary: 'Pause',
    });
    assert.equal('errorCode' in record, false);
    assert.equal('params' in record, false);
    assert.equal('confirmation' in record, false);
  });

  it('carries failure detail when present', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    const record = await log.record({
      action: 'start_print',
      outcome: 'denied',
      dryRun: false,
      summary: 'refused',
      errorCode: 'STATE_CONFLICT',
      errorMessage: 'already printing',
      confirmation: 'abc123',
      durationMs: 12,
    });
    assert.equal(record.errorCode, 'STATE_CONFLICT');
    assert.equal(record.errorMessage, 'already printing');
    assert.equal(record.confirmation, 'abc123');
    assert.equal(record.durationMs, 12);
  });
});

describe('AuditLog — the in-memory ring', () => {
  it('returns records oldest-first', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    for (const summary of ['one', 'two', 'three']) {
      await log.record({
        action: 'pause_print',
        outcome: 'planned',
        dryRun: true,
        summary,
      });
    }
    assert.deepEqual(
      log.recent().map((r: AuditRecord) => r.summary),
      ['one', 'two', 'three'],
    );
  });

  it('honours the requested limit, returning the newest', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    for (const summary of ['one', 'two', 'three']) {
      await log.record({ action: 'pause_print', outcome: 'planned', dryRun: true, summary });
    }
    assert.deepEqual(
      log.recent(2).map((r: AuditRecord) => r.summary),
      ['two', 'three'],
    );
  });

  it('bounds memory growth', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK, maxMemoryRecords: 3 });
    for (let i = 0; i < 10; i += 1) {
      await log.record({
        action: 'pause_print',
        outcome: 'planned',
        dryRun: true,
        summary: `entry-${i}`,
      });
    }
    const recent = log.recent(100);
    assert.equal(recent.length, 3);
    assert.deepEqual(
      recent.map((r: AuditRecord) => r.summary),
      ['entry-7', 'entry-8', 'entry-9'],
    );
  });

  it('handles a zero limit', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    await log.record({ action: 'pause_print', outcome: 'planned', dryRun: true, summary: 'x' });
    assert.deepEqual(log.recent(0), []);
  });
});

describe('AuditLog — the sink', () => {
  it('writes one JSON object per line', async () => {
    const sink = createAuditSink();
    const log = new AuditLog({ now: FIXED_CLOCK, write: sink.write });
    await log.record({
      action: 'start_print',
      outcome: 'applied',
      dryRun: false,
      summary: 'Start',
    });
    await log.flush();

    assert.equal(sink.lines.length, 1);
    assert.ok(sink.lines[0]?.endsWith('\n'));
    const parsed: unknown = JSON.parse(sink.lines[0] as string);
    assert.equal((parsed as AuditRecord).action, 'start_print');
  });

  it('serialises concurrent writes into ordered whole lines', async () => {
    const sink = createAuditSink();
    const log = new AuditLog({ now: FIXED_CLOCK, write: sink.write });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.record({
          action: 'pause_print',
          outcome: 'planned',
          dryRun: true,
          summary: `entry-${i}`,
        }),
      ),
    );
    await log.flush();

    assert.equal(sink.lines.length, 20);
    sink.lines.forEach((line, index) => {
      const parsed = JSON.parse(line) as AuditRecord;
      assert.equal(parsed.summary, `entry-${index}`, 'lines must stay in order');
    });
  });

  it('never lets a failing sink break the action', async () => {
    const seen: unknown[] = [];
    const log = new AuditLog({
      now: FIXED_CLOCK,
      write: () => Promise.reject(new Error('disk full')),
      onWriteError: (error) => seen.push(error),
    });

    await assert.doesNotReject(async () => {
      await log.record({
        action: 'cancel_print',
        outcome: 'applied',
        dryRun: false,
        summary: 'Cancel',
      });
    });
    await log.flush();

    assert.equal(seen.length, 1);
    // The record still exists in memory even though the sink failed.
    assert.equal(log.recent().length, 1);
  });

  it('is a no-op sink when neither writer nor path is configured', async () => {
    const log = new AuditLog({ now: FIXED_CLOCK });
    await log.record({ action: 'pause_print', outcome: 'planned', dryRun: true, summary: 'x' });
    await log.flush();
    assert.equal(log.filePath, undefined);
  });
});

describe('AuditLog — the JSONL file', () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('appends to a file, creating the directory if needed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'creality-audit-'));
    dirs.push(dir);
    const filePath = join(dir, 'nested', 'audit.jsonl');
    const log = new AuditLog({ now: FIXED_CLOCK, filePath });

    assert.equal(log.filePath, filePath);
    await log.record({
      action: 'start_print',
      outcome: 'applied',
      dryRun: false,
      summary: 'Start',
    });
    await log.record({
      action: 'cancel_print',
      outcome: 'denied',
      dryRun: false,
      summary: 'Refused',
      errorCode: 'STATE_CONFLICT',
    });
    await log.flush();

    const contents = await readFile(filePath, 'utf8');
    const lines = contents.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0] as string) as AuditRecord).action, 'start_print');
    assert.equal((JSON.parse(lines[1] as string) as AuditRecord).errorCode, 'STATE_CONFLICT');
  });
});

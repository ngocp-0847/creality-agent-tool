/**
 * Append-only audit trail for mutating actions.
 *
 * Every attempt to change the printer's physical state is recorded — including
 * the ones that were refused. A denial is the most interesting record in the
 * file: it is the evidence that a guard rail did its job.
 *
 * Records are held in a bounded in-memory ring and, when `filePath` is set,
 * appended as JSONL. File writes are serialised through a single promise chain
 * so concurrent actions cannot interleave partial lines, and a failing sink
 * never propagates into the action itself: losing an audit line must not abort
 * a print that is already underway.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ErrorCode } from './errors.js';

export type AuditOutcome = 'planned' | 'applied' | 'denied' | 'failed';

export interface AuditRecord {
  readonly ts: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly dryRun: boolean;
  readonly summary: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  /** Fingerprint of the confirmation ticket that authorised this action. */
  readonly confirmation?: string;
}

export interface AuditEntry {
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly dryRun: boolean;
  readonly summary: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
  readonly durationMs?: number;
  readonly confirmation?: string;
}

export interface AuditLogOptions {
  /** JSONL sink. When unset, records live only in memory. */
  readonly filePath?: string;
  readonly maxMemoryRecords?: number;
  readonly now?: () => Date;
  /** Injected for tests, and for callers routing audit elsewhere. */
  readonly write?: (line: string) => Promise<void>;
  /** Notified when the sink fails; defaults to a stderr warning. */
  readonly onWriteError?: (error: unknown) => void;
}

const DEFAULT_MAX_MEMORY_RECORDS = 500;
const MAX_STRING_LENGTH = 512;
const REDACTED = '[redacted]';
const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|authorization|cookie)/i;

/**
 * Defence in depth: callers are expected to pass digests rather than payloads,
 * but the audit file is the last place a credential should ever land.
 */
export function redactParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (params === undefined) return undefined;
  return redactObject(params, 0);
}

function redactObject(
  source: Readonly<Record<string, unknown>>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redactValue(value, depth + 1);
  }
  return result;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[${value.length} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((entry) => redactValue(entry, depth + 1));
    return value.length > 20 ? [...head, `…[${value.length} items]`] : head;
  }
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (value !== null && typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, depth);
  }
  return value;
}

export class AuditLog {
  readonly #filePath: string | undefined;
  readonly #maxMemoryRecords: number;
  readonly #now: () => Date;
  readonly #write: ((line: string) => Promise<void>) | undefined;
  readonly #onWriteError: (error: unknown) => void;
  readonly #records: AuditRecord[] = [];
  #chain: Promise<void> = Promise.resolve();
  #directoryReady = false;

  constructor(options: AuditLogOptions = {}) {
    this.#filePath = options.filePath;
    this.#maxMemoryRecords = options.maxMemoryRecords ?? DEFAULT_MAX_MEMORY_RECORDS;
    this.#now = options.now ?? ((): Date => new Date());
    this.#write = options.write;
    this.#onWriteError =
      options.onWriteError ??
      ((error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[creality-agent-tool] audit write failed: ${message}\n`);
      });
  }

  get filePath(): string | undefined {
    return this.#filePath;
  }

  /** Record an entry. Resolves once the sink has accepted it (or failed softly). */
  async record(entry: AuditEntry): Promise<AuditRecord> {
    const params = redactParams(entry.params);
    const record: AuditRecord = {
      ts: this.#now().toISOString(),
      action: entry.action,
      outcome: entry.outcome,
      dryRun: entry.dryRun,
      summary: entry.summary,
      ...(params === undefined ? {} : { params }),
      ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
      ...(entry.errorMessage === undefined ? {} : { errorMessage: entry.errorMessage }),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      ...(entry.confirmation === undefined ? {} : { confirmation: entry.confirmation }),
    };

    this.#records.push(record);
    if (this.#records.length > this.#maxMemoryRecords) {
      this.#records.splice(0, this.#records.length - this.#maxMemoryRecords);
    }

    await this.#append(record);
    return record;
  }

  /** Most recent records, oldest first. */
  recent(limit = 50): readonly AuditRecord[] {
    const count = Math.max(0, Math.min(limit, this.#records.length));
    return this.#records.slice(this.#records.length - count);
  }

  /** Resolve once all queued sink writes have settled. */
  async flush(): Promise<void> {
    await this.#chain;
  }

  #append(record: AuditRecord): Promise<void> {
    const sink = this.#write;
    const filePath = this.#filePath;
    if (sink === undefined && filePath === undefined) return Promise.resolve();

    const line = `${JSON.stringify(record)}\n`;
    this.#chain = this.#chain.then(async () => {
      try {
        if (sink !== undefined) {
          await sink(line);
          return;
        }
        /* c8 ignore next */
        if (filePath === undefined) return;
        if (!this.#directoryReady) {
          await mkdir(dirname(filePath), { recursive: true });
          this.#directoryReady = true;
        }
        await appendFile(filePath, line, 'utf8');
      } catch (error) {
        this.#onWriteError(error);
      }
    });
    return this.#chain;
  }
}

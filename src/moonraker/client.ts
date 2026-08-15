/**
 * Moonraker REST client.
 *
 * Only the endpoints this tool needs are implemented, and deliberately *not*
 * `/printer/gcode/script`: arbitrary G-code execution is out of scope by design.
 */

import { CrealityError } from '../errors.js';
import type { HttpClient } from '../net/http.js';
import type {
  MoonrakerEnvelope,
  RawFileEntry,
  RawFileMetadata,
  RawObjectQuery,
  RawPrinterInfo,
  RawServerInfo,
  RawUploadResult,
} from './types.js';

const QUERY_OBJECTS = [
  'print_stats',
  'extruder',
  'heater_bed',
  'display_status',
  'virtual_sdcard',
  'toolhead',
  'fan',
  'heater_generic chamber',
] as const;

export interface UploadRequest {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly startPrint: boolean;
  readonly timeoutMs?: number;
}

function unwrap<T>(envelope: MoonrakerEnvelope<T>, what: string): T {
  if (envelope.error !== undefined) {
    const message =
      typeof envelope.error === 'string' ? envelope.error : (envelope.error.message ?? 'unknown');
    throw new CrealityError('PRINTER_ERROR', `Moonraker rejected ${what}: ${message}`, {
      details: { operation: what },
    });
  }
  if (envelope.result === undefined) {
    throw new CrealityError('PROTOCOL', `Moonraker response for ${what} had no result field.`, {
      details: { operation: what },
    });
  }
  return envelope.result;
}

export class MoonrakerClient {
  readonly #http: HttpClient;

  constructor(http: HttpClient) {
    this.#http = http;
  }

  async printerInfo(): Promise<RawPrinterInfo> {
    return unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<RawPrinterInfo>>({ path: '/printer/info' }),
      'printer info',
    );
  }

  async serverInfo(): Promise<RawServerInfo> {
    return unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<RawServerInfo>>({ path: '/server/info' }),
      'server info',
    );
  }

  async queryObjects(): Promise<RawObjectQuery> {
    const query = Object.fromEntries(QUERY_OBJECTS.map((name) => [name, '']));
    return unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<RawObjectQuery>>({
        path: '/printer/objects/query',
        query,
      }),
      'object query',
    );
  }

  async listGcodeFiles(): Promise<readonly RawFileEntry[]> {
    const result = unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<readonly RawFileEntry[]>>({
        path: '/server/files/list',
        query: { root: 'gcodes' },
      }),
      'file list',
    );
    // Firmware builds occasionally return a non-array here; treat that as "no files"
    // rather than letting a malformed body propagate as a mapping crash.
    return Array.isArray(result) ? (result as readonly RawFileEntry[]) : [];
  }

  async fileMetadata(filename: string): Promise<RawFileMetadata> {
    return unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<RawFileMetadata>>({
        path: '/server/files/metadata',
        query: { filename },
      }),
      `metadata for ${filename}`,
    );
  }

  async upload(request: UploadRequest): Promise<RawUploadResult> {
    const form = new FormData();
    form.set('root', 'gcodes');
    form.set('print', request.startPrint ? 'true' : 'false');
    form.set(
      'file',
      new Blob([request.bytes], { type: 'application/octet-stream' }),
      request.filename,
    );
    return unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<RawUploadResult>>({
        method: 'POST',
        path: '/server/files/upload',
        body: form,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      }),
      `upload of ${request.filename}`,
    );
  }

  async startPrint(filename: string): Promise<void> {
    unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<unknown>>({
        method: 'POST',
        path: '/printer/print/start',
        query: { filename },
      }),
      `print start for ${filename}`,
    );
  }

  async pausePrint(): Promise<void> {
    unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<unknown>>({
        method: 'POST',
        path: '/printer/print/pause',
      }),
      'pause',
    );
  }

  async resumePrint(): Promise<void> {
    unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<unknown>>({
        method: 'POST',
        path: '/printer/print/resume',
      }),
      'resume',
    );
  }

  async cancelPrint(): Promise<void> {
    unwrap(
      await this.#http.requestJson<MoonrakerEnvelope<unknown>>({
        method: 'POST',
        path: '/printer/print/cancel',
      }),
      'cancel',
    );
  }
}

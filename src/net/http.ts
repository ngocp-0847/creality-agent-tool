/**
 * Minimal HTTP client for Moonraker.
 *
 * Responsibilities beyond `fetch`: SSRF-validated + address-pinned targets,
 * hard per-request deadlines, refusal to follow redirects, a bounded response
 * reader, and mapping every transport/HTTP failure onto {@link CrealityError}.
 */

import { CrealityError } from '../errors.js';
import { validateTarget, type ValidatedTarget, type ValidateTargetOptions } from './ssrf.js';

export type QueryValue = string | number | boolean | undefined;

type FetchInit = NonNullable<Parameters<typeof globalThis.fetch>[1]>;
/** `BodyInit` is not a global under Node's type definitions; derive it from `fetch`. */
export type RequestBody = NonNullable<FetchInit['body']>;

export interface HttpRequestOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: RequestBody;
  readonly timeoutMs?: number;
  /** Bound on the response body we are willing to buffer. */
  readonly maxResponseBytes?: number;
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly requestTimeoutMs: number;
  readonly allowPublicNetwork: boolean;
  readonly allowedHosts: readonly string[];
}

export interface HttpClientDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly resolver?: ValidateTargetOptions['resolver'];
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Re-validate DNS periodically so a moved printer is noticed, without per-call lookups. */
const TARGET_CACHE_TTL_MS = 60_000;

export class HttpClient {
  readonly #options: HttpClientOptions;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #resolver: ValidateTargetOptions['resolver'];
  #target: { value: ValidatedTarget; validatedAt: number } | undefined;

  constructor(options: HttpClientOptions, deps: HttpClientDeps = {}) {
    this.#options = options;
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#now = deps.now ?? Date.now;
    this.#resolver = deps.resolver;
  }

  /** Resolve + validate the printer target, memoised for a short window. */
  async target(): Promise<ValidatedTarget> {
    const cached = this.#target;
    if (cached !== undefined && this.#now() - cached.validatedAt < TARGET_CACHE_TTL_MS) {
      return cached.value;
    }
    const value = await validateTarget(this.#options.baseUrl, {
      allowPublicNetwork: this.#options.allowPublicNetwork,
      allowedHosts: this.#options.allowedHosts,
      ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
    });
    this.#target = { value, validatedAt: this.#now() };
    return value;
  }

  async requestJson<T>(options: HttpRequestOptions): Promise<T> {
    const { text, status } = await this.requestText(options);
    if (text.trim() === '') {
      throw new CrealityError('PROTOCOL', `Printer returned an empty body (HTTP ${status}).`, {
        details: { path: options.path, status },
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new CrealityError('PROTOCOL', `Printer returned a non-JSON body (HTTP ${status}).`, {
        cause,
        details: { path: options.path, status, preview: text.slice(0, 200) },
      });
    }
  }

  async requestText(
    options: HttpRequestOptions,
  ): Promise<{ readonly text: string; readonly status: number }> {
    const target = await this.target();
    const requestUrl = this.#buildUrl(target, options);
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;

    const headers = new Headers(options.headers);
    headers.set('accept', 'application/json, text/plain;q=0.8, */*;q=0.1');
    // Pinning: we connect to the validated IP and restore the intended Host header,
    // so a rebinding answer between validation and connect cannot redirect us.
    if (requestUrl.pinned) headers.set('host', this.#hostHeader(target));
    if (this.#options.apiKey !== undefined) headers.set('x-api-key', this.#options.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new CrealityError('TIMEOUT', `Request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await this.#fetch(requestUrl.url, {
        method: options.method ?? 'GET',
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (cause) {
      throw this.#transportError(cause, options, timeoutMs);
    } finally {
      clearTimeout(timer);
    }

    const text = await this.#readBounded(
      response,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      options,
    );

    if (!response.ok) throw this.#httpError(response.status, text, options);
    return { text, status: response.status };
  }

  #hostHeader(target: ValidatedTarget): string {
    const defaultPort = target.protocol === 'https:' ? 443 : 80;
    const host = target.hostname.includes(':') ? `[${target.hostname}]` : target.hostname;
    return target.port === defaultPort ? host : `${host}:${target.port}`;
  }

  #buildUrl(
    target: ValidatedTarget,
    options: HttpRequestOptions,
  ): { readonly url: string; readonly pinned: boolean } {
    // Pin to the validated address for plaintext HTTP. Over TLS we keep the
    // hostname so SNI and certificate validation still work; the address checks
    // above still apply, but see README for the residual rebinding caveat.
    const pinned = target.protocol === 'http:' && !target.literal;
    const authorityHost = pinned
      ? target.pinnedAddress.family === 6
        ? `[${target.pinnedAddress.address}]`
        : target.pinnedAddress.address
      : target.url.host;
    const authority = pinned ? `${authorityHost}:${target.port}` : authorityHost;

    const basePath = target.url.pathname.replace(/\/+$/, '');
    const path = options.path.startsWith('/') ? options.path : `/${options.path}`;
    const url = new URL(`${target.protocol}//${authority}${basePath}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return { url: url.toString(), pinned };
  }

  #transportError(cause: unknown, options: HttpRequestOptions, timeoutMs: number): CrealityError {
    if (CrealityError.is(cause)) return cause;
    const abortReason = (cause as { name?: string } | undefined)?.name;
    if (abortReason === 'AbortError' || abortReason === 'TimeoutError') {
      return new CrealityError(
        'TIMEOUT',
        `Request to ${options.path} timed out after ${timeoutMs}ms.`,
        { details: { path: options.path, timeoutMs }, retryable: true },
      );
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/redirect/i.test(message)) {
      return new CrealityError(
        'HOST_NOT_ALLOWED',
        `Printer attempted to redirect ${options.path}; redirects are refused.`,
        { cause, details: { path: options.path } },
      );
    }
    return new CrealityError('NETWORK', `Could not reach the printer (${message}).`, {
      cause,
      details: { path: options.path },
      retryable: true,
    });
  }

  async #readBounded(
    response: Response,
    maxBytes: number,
    options: HttpRequestOptions,
  ): Promise<string> {
    const body: ReadableStream<Uint8Array> | null = response.body;
    if (body === null) return '';
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new CrealityError(
            'PAYLOAD_TOO_LARGE',
            `Response from ${options.path} exceeded ${maxBytes} bytes.`,
            { details: { path: options.path, maxBytes } },
          );
        }
        chunks.push(value);
      }
    } catch (cause) {
      if (CrealityError.is(cause)) throw cause;
      throw new CrealityError('NETWORK', `Failed reading response from ${options.path}.`, {
        cause,
        retryable: true,
      });
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  #httpError(status: number, text: string, options: HttpRequestOptions): CrealityError {
    const detail = extractMoonrakerMessage(text) ?? text.slice(0, 200);
    const details = { path: options.path, status, ...(detail === '' ? {} : { detail }) };
    if (status === 404) {
      return new CrealityError('NOT_FOUND', detail === '' ? `Not found: ${options.path}` : detail, {
        details,
      });
    }
    if (status === 401 || status === 403) {
      return new CrealityError(
        'PRINTER_ERROR',
        `Printer rejected the request (HTTP ${status}). Check CREALITY_API_KEY.`,
        { details },
      );
    }
    if (status === 413) {
      return new CrealityError('PAYLOAD_TOO_LARGE', `Printer rejected the payload as too large.`, {
        details,
      });
    }
    if (status >= 500) {
      return new CrealityError(
        'PRINTER_ERROR',
        `Printer returned HTTP ${status}${detail === '' ? '' : `: ${detail}`}.`,
        { details, retryable: true },
      );
    }
    return new CrealityError(
      'PRINTER_ERROR',
      `Printer returned HTTP ${status}${detail === '' ? '' : `: ${detail}`}.`,
      { details },
    );
  }
}

/** Moonraker errors come back as `{"error": {"message": "..."}}`. */
export function extractMoonrakerMessage(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

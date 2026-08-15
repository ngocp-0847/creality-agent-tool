/**
 * Local model editor.
 *
 * A localhost-only HTTP surface over {@link ModelService}: list projects, edit
 * OpenSCAD source, render previews, export meshes. It is a view onto the CAD
 * workspace and nothing else — there is deliberately no route that touches a
 * printer, because a browser tab is the wrong place to authorise heating a
 * nozzle. Printer actions stay behind the MCP tools and their confirmation
 * flow.
 *
 * Defences, given that the browser is an untrusted-ish caller on a machine that
 * may be running other pages:
 *
 *   - bind to loopback, enforced again by rejecting non-loopback `Host` headers
 *     (a DNS-rebinding page resolves to 127.0.0.1 but carries its own Host)
 *   - reject cross-origin `Origin` headers outright
 *   - require `content-type: application/json` on writes, which blocks the
 *     simple-request forms an HTML form could send without a preflight
 *   - bound the request body, and refuse chunked bodies past the same bound
 *   - `default-src 'none'` CSP, `nosniff`, and no third-party assets
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CrealityError, type ErrorCode } from '../errors.js';
import type { ModelService } from '../model/service.js';
import { EXPORT_FORMATS, PREVIEW_VIEWS, type ExportFormat, type PreviewView } from '../model/types.js';
import { APP_CSS, APP_JS, INDEX_HTML } from './ui.js';

/** Generous for source, tiny compared with anything that could exhaust memory. */
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

const LOOPBACK_HOST_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

const STATUS_BY_CODE: Partial<Record<ErrorCode, number>> = {
  CONFIG_INVALID: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RENDER_FAILED: 422,
  TOOL_UNAVAILABLE: 503,
  TIMEOUT: 504,
  UNSUPPORTED: 501,
};

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export interface ModelWebServerOptions {
  readonly service: ModelService;
  readonly maxBodyBytes?: number;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Strip the port and brackets from a `Host` / `Origin` authority. */
function hostnameOf(authority: string): string {
  const trimmed = authority.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  const colon = trimmed.lastIndexOf(':');
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function assertLocalRequest(request: IncomingMessage): void {
  const host = request.headers.host;
  if (host === undefined || !LOOPBACK_HOST_NAMES.has(hostnameOf(host))) {
    throw new HttpError(
      403,
      'HOST_NOT_ALLOWED',
      'This editor only answers requests addressed to localhost.',
    );
  }

  const origin = request.headers.origin;
  if (origin !== undefined && origin !== 'null') {
    let originHost: string;
    try {
      originHost = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Malformed Origin header.');
    }
    if (!LOOPBACK_HOST_NAMES.has(originHost)) {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', `Cross-origin request from ${origin} refused.`);
    }
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Request body must be sent as application/json.',
    );
  }

  const declared = request.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) {
    throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  // A truthful content-length is not required; the stream is bounded regardless.
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      request.destroy();
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': contentType,
    'content-length': payload.byteLength,
  });
  response.end(payload);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, {
      error: { code: error.code, message: error.message, retryable: false },
    });
    return;
  }
  const wrapped = CrealityError.wrap(error);
  const status = STATUS_BY_CODE[wrapped.code] ?? 500;
  sendJson(response, status, { error: wrapped.toJSON() });
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_FIELD', `"${key}" must be a string.`);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined) {
    throw new HttpError(400, 'INVALID_FIELD', `"${key}" is required.`);
  }
  return value;
}

function parseViews(body: Record<string, unknown>): readonly PreviewView[] | undefined {
  const value = body['views'];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_FIELD', '"views" must be an array.');
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || !PREVIEW_VIEWS.includes(entry as PreviewView)) {
      throw new HttpError(
        400,
        'INVALID_FIELD',
        `"views" entries must be one of: ${PREVIEW_VIEWS.join(', ')}.`,
      );
    }
    return entry as PreviewView;
  });
}

function parseFormat(body: Record<string, unknown>): ExportFormat {
  const value = requiredString(body, 'format').toLowerCase();
  if (!EXPORT_FORMATS.includes(value as ExportFormat)) {
    throw new HttpError(
      400,
      'INVALID_FIELD',
      `"format" must be one of: ${EXPORT_FORMATS.join(', ')}.`,
    );
  }
  return value as ExportFormat;
}

/** Build the request handler. Exported so tests can drive it over a real socket. */
export function createModelWebHandler(options: ModelWebServerOptions): RequestHandler {
  const { service } = options;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    assertLocalRequest(request);

    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', `${method} is not supported.`);
    }

    // --- static assets ------------------------------------------------------
    if (method === 'GET' || method === 'HEAD') {
      if (path === '/' || path === '/index.html') {
        send(response, 200, 'text/html; charset=utf-8', INDEX_HTML);
        return;
      }
      if (path === '/app.css') {
        send(response, 200, 'text/css; charset=utf-8', APP_CSS);
        return;
      }
      if (path === '/app.js') {
        send(response, 200, 'text/javascript; charset=utf-8', APP_JS);
        return;
      }
      if (path === '/api/toolchain') {
        sendJson(response, 200, await service.toolchain());
        return;
      }
      if (path === '/api/projects') {
        sendJson(response, 200, { projects: await service.list() });
        return;
      }

      const artifact = /^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
      if (artifact !== null) {
        const file = await service.readArtifact(
          decodeURIComponent(artifact[1] ?? ''),
          decodeURIComponent(artifact[2] ?? ''),
        );
        send(response, 200, file.contentType, file.bytes);
        return;
      }

      const detail = /^\/api\/projects\/([^/]+)$/.exec(path);
      if (detail !== null) {
        sendJson(response, 200, await service.read(decodeURIComponent(detail[1] ?? '')));
        return;
      }
    }

    // --- writes -------------------------------------------------------------
    if (method === 'POST') {
      if (path === '/api/projects') {
        const body = await readJsonBody(request, maxBodyBytes);
        const id = optionalString(body, 'id');
        const project = await service.create({
          ...(id === undefined ? {} : { id }),
          name: requiredString(body, 'name'),
          prompt: requiredString(body, 'prompt'),
          source: requiredString(body, 'source'),
        });
        sendJson(response, 201, project);
        return;
      }

      const save = /^\/api\/projects\/([^/]+)\/save$/.exec(path);
      if (save !== null) {
        const body = await readJsonBody(request, maxBodyBytes);
        const prompt = optionalString(body, 'prompt');
        const note = optionalString(body, 'note');
        sendJson(
          response,
          200,
          await service.update({
            id: decodeURIComponent(save[1] ?? ''),
            source: requiredString(body, 'source'),
            ...(prompt === undefined ? {} : { prompt }),
            ...(note === undefined ? {} : { note }),
          }),
        );
        return;
      }

      const render = /^\/api\/projects\/([^/]+)\/render$/.exec(path);
      if (render !== null) {
        const body = await readJsonBody(request, maxBodyBytes);
        const views = parseViews(body);
        sendJson(
          response,
          200,
          await service.renderPreview({
            id: decodeURIComponent(render[1] ?? ''),
            ...(views === undefined ? {} : { views }),
          }),
        );
        return;
      }

      const exportMatch = /^\/api\/projects\/([^/]+)\/export$/.exec(path);
      if (exportMatch !== null) {
        const body = await readJsonBody(request, maxBodyBytes);
        sendJson(
          response,
          200,
          await service.export({
            id: decodeURIComponent(exportMatch[1] ?? ''),
            format: parseFormat(body),
          }),
        );
        return;
      }
    }

    throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${path}.`);
  };

  return (request: IncomingMessage, response: ServerResponse): void => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendError(response, error);
    });
  };
}

export interface RunningModelWebServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Start the editor on a loopback interface. */
export async function startModelWebServer(options: {
  readonly service: ModelService;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes?: number;
}): Promise<RunningModelWebServer> {
  const handler = createModelWebHandler({
    service: options.service,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
  });
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;
  const displayHost = options.host.includes(':') ? `[${options.host}]` : options.host;

  return {
    server,
    port,
    url: `http://${displayHost}:${port}/`,
    close: async (): Promise<void> => {
      // Idle keep-alive sockets would otherwise hold the close open.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      });
    },
  };
}

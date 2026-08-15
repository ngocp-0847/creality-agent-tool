import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import { HttpClient, extractMoonrakerMessage, type HttpClientOptions } from '../src/net/http.js';

const BASE_OPTIONS = {
  baseUrl: 'http://192.168.1.42:7125',
  requestTimeoutMs: 5_000,
  allowPublicNetwork: false,
  allowedHosts: [] as readonly string[],
};

interface Captured {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function clientWith(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
  overrides: Partial<HttpClientOptions> = {},
): { client: HttpClient; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    captured.push({ url, init });
    return await handler(url, init);
  }) as unknown as typeof globalThis.fetch;

  return {
    client: new HttpClient({ ...BASE_OPTIONS, ...overrides }, { fetch: fetchImpl }),
    captured,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

async function expectCode(run: () => Promise<unknown>, code: string, pattern?: RegExp): Promise<CrealityError> {
  let captured: CrealityError | undefined;
  await assert.rejects(run, (error: unknown) => {
    assert.ok(CrealityError.is(error), 'expected a CrealityError');
    assert.equal(error.code, code);
    if (pattern !== undefined) assert.match(error.message, pattern);
    captured = error;
    return true;
  });
  assert.ok(captured);
  return captured;
}

describe('HttpClient — requests', () => {
  it('builds the URL from base, path and query', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }));
    await client.requestJson({ path: '/printer/info', query: { filename: 'a b.gcode' } });

    const url = new URL(captured[0]?.url ?? '');
    assert.equal(url.host, '192.168.1.42:7125');
    assert.equal(url.pathname, '/printer/info');
    assert.equal(url.searchParams.get('filename'), 'a b.gcode');
  });

  it('tolerates a path given without a leading slash', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }));
    await client.requestJson({ path: 'server/info' });
    assert.equal(new URL(captured[0]?.url ?? '').pathname, '/server/info');
  });

  it('omits undefined query values', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }));
    await client.requestJson({ path: '/x', query: { a: 'set', b: undefined } });
    const url = new URL(captured[0]?.url ?? '');
    assert.equal(url.searchParams.get('a'), 'set');
    assert.equal(url.searchParams.has('b'), false);
  });

  it('sends the API key header when configured', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }), { apiKey: 'secret-key' });
    await client.requestJson({ path: '/printer/info' });
    const headers = new Headers(captured[0]?.init?.headers);
    assert.equal(headers.get('x-api-key'), 'secret-key');
  });

  it('omits the API key header when not configured', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }));
    await client.requestJson({ path: '/printer/info' });
    assert.equal(new Headers(captured[0]?.init?.headers).has('x-api-key'), false);
  });

  it('refuses to follow redirects', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }));
    await client.requestJson({ path: '/printer/info' });
    assert.equal(captured[0]?.init?.redirect, 'error');
  });

  it('passes the requested method through', async () => {
    const { client, captured } = clientWith(() => json({ result: 'ok' }));
    await client.requestJson({ method: 'POST', path: '/printer/print/pause' });
    assert.equal(captured[0]?.init?.method, 'POST');
  });

  it('caches target validation across calls', async () => {
    const { client } = clientWith(() => json({ result: 'ok' }));
    const first = await client.target();
    const second = await client.target();
    assert.equal(first, second, 'the validated target should be memoised');
  });
});

describe('HttpClient — response handling', () => {
  it('parses a JSON body', async () => {
    const { client } = clientWith(() => json({ result: { state: 'ready' } }));
    const body = await client.requestJson<{ result: { state: string } }>({ path: '/printer/info' });
    assert.equal(body.result.state, 'ready');
  });

  it('reports an empty body as a protocol error', async () => {
    const { client } = clientWith(() => new Response('', { status: 200 }));
    await expectCode(
      async () => await client.requestJson({ path: '/printer/info' }),
      'PROTOCOL',
      /empty body/,
    );
  });

  it('reports a non-JSON body as a protocol error', async () => {
    const { client } = clientWith(() => new Response('<html>nope</html>', { status: 200 }));
    await expectCode(
      async () => await client.requestJson({ path: '/printer/info' }),
      'PROTOCOL',
      /non-JSON body/,
    );
  });

  it('refuses a response beyond the byte ceiling', async () => {
    const { client } = clientWith(() => new Response('x'.repeat(5000), { status: 200 }));
    await expectCode(
      async () => await client.requestJson({ path: '/big', maxResponseBytes: 100 }),
      'PAYLOAD_TOO_LARGE',
      /exceeded 100 bytes/,
    );
  });

  it('returns the status alongside the text', async () => {
    const { client } = clientWith(() => new Response('plain', { status: 200 }));
    const result = await client.requestText({ path: '/x' });
    assert.equal(result.status, 200);
    assert.equal(result.text, 'plain');
  });
});

describe('HttpClient — HTTP error mapping', () => {
  const cases: readonly [number, string][] = [
    [404, 'NOT_FOUND'],
    [401, 'PRINTER_ERROR'],
    [403, 'PRINTER_ERROR'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [400, 'PRINTER_ERROR'],
    [500, 'PRINTER_ERROR'],
    [503, 'PRINTER_ERROR'],
  ];

  for (const [status, code] of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const { client } = clientWith(() => json({ error: { message: 'boom' } }, status));
      await expectCode(async () => await client.requestJson({ path: '/x' }), code);
    });
  }

  it('marks 5xx as retryable and 4xx as not', async () => {
    const server = clientWith(() => json({ error: { message: 'boom' } }, 500));
    const serverError = await expectCode(
      async () => await server.client.requestJson({ path: '/x' }),
      'PRINTER_ERROR',
    );
    assert.equal(serverError.retryable, true);

    const client4xx = clientWith(() => json({ error: { message: 'boom' } }, 400));
    const clientError = await expectCode(
      async () => await client4xx.client.requestJson({ path: '/x' }),
      'PRINTER_ERROR',
    );
    assert.equal(clientError.retryable, false);
  });

  it("surfaces Moonraker's own error message", async () => {
    const { client } = clientWith(() =>
      json({ error: { message: 'File not found: ghost.gcode' } }, 404),
    );
    const error = await expectCode(
      async () => await client.requestJson({ path: '/server/files/metadata' }),
      'NOT_FOUND',
    );
    assert.match(error.message, /ghost\.gcode/);
  });

  it('points at the API key on an auth failure', async () => {
    const { client } = clientWith(() => new Response('denied', { status: 401 }));
    const error = await expectCode(async () => await client.requestJson({ path: '/x' }), 'PRINTER_ERROR');
    assert.match(error.message, /CREALITY_API_KEY/);
  });
});

describe('HttpClient — transport failures', () => {
  it('maps a timeout to TIMEOUT', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      })) as unknown as typeof globalThis.fetch;

    const client = new HttpClient(
      { ...BASE_OPTIONS, requestTimeoutMs: 20 },
      { fetch: fetchImpl },
    );
    await expectCode(async () => await client.requestJson({ path: '/slow' }), 'TIMEOUT', /timed out/);
  });

  it('maps an AbortError without a reason to TIMEOUT', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { client } = clientWith(() => Promise.reject(abort));
    await expectCode(async () => await client.requestJson({ path: '/x' }), 'TIMEOUT');
  });

  it('maps a refused redirect to HOST_NOT_ALLOWED', async () => {
    const { client } = clientWith(() => Promise.reject(new TypeError('unexpected redirect')));
    await expectCode(
      async () => await client.requestJson({ path: '/x' }),
      'HOST_NOT_ALLOWED',
      /redirects are refused/,
    );
  });

  it('maps a connection failure to a retryable NETWORK error', async () => {
    const { client } = clientWith(() => Promise.reject(new Error('ECONNREFUSED')));
    const error = await expectCode(async () => await client.requestJson({ path: '/x' }), 'NETWORK');
    assert.equal(error.retryable, true);
  });

  it('propagates an SSRF refusal from target validation', async () => {
    const client = new HttpClient(
      { ...BASE_OPTIONS, baseUrl: 'http://8.8.8.8:7125' },
      { fetch: (() => json({ result: 'ok' })) as unknown as typeof globalThis.fetch },
    );
    await expectCode(async () => await client.requestJson({ path: '/x' }), 'HOST_NOT_ALLOWED');
  });
});

describe('extractMoonrakerMessage', () => {
  it('reads the nested message form', () => {
    assert.equal(extractMoonrakerMessage('{"error":{"message":"boom"}}'), 'boom');
  });

  it('reads the flat string form', () => {
    assert.equal(extractMoonrakerMessage('{"error":"boom"}'), 'boom');
  });

  it('returns undefined for anything else', () => {
    assert.equal(extractMoonrakerMessage('not json'), undefined);
    assert.equal(extractMoonrakerMessage('{"result":"ok"}'), undefined);
    assert.equal(extractMoonrakerMessage('null'), undefined);
    assert.equal(extractMoonrakerMessage('{"error":{}}'), undefined);
    assert.equal(extractMoonrakerMessage('[1,2,3]'), undefined);
  });
});

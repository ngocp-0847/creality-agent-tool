/**
 * Editor HTTP tests.
 *
 * The server is started on a real loopback socket with an ephemeral port and
 * driven with `fetch`, so header handling, status codes and body limits are
 * exercised as a browser would meet them. OpenSCAD is mocked throughout.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { startModelWebServer, type RunningModelWebServer } from '../src/web/server.js';
import { createModelFixture, SAMPLE_SCAD, type ModelFixture } from './model-helpers.js';

let fixture: ModelFixture;
let server: RunningModelWebServer;
let base: string;

beforeEach(async () => {
  fixture = await createModelFixture();
  server = await startModelWebServer({
    service: fixture.service,
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 64 * 1024,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  await fixture.cleanup();
});

/** `Response.json()` is `unknown`; these tests assert on shapes they already know. */
const readJson = async (response: Response): Promise<any> => await response.json();

const get = async (path: string, init: RequestInit = {}) => await fetch(`${base}${path}`, init);

const post = async (path: string, body: unknown, init: RequestInit = {}) =>
  await fetch(`${base}${path}`, {
    ...init,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  });

/**
 * `Host` is a forbidden header for fetch, so the rebinding guard has to be
 * driven with a raw socket request.
 */
async function rawGet(
  path: string,
  host: string,
): Promise<{ status: number; body: string }> {
  const { request } = await import('node:http');
  return await new Promise((resolve, reject) => {
    const call = request(
      { host: '127.0.0.1', port: server.port, path, method: 'GET', headers: { Host: host } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    call.on('error', reject);
    call.end();
  });
}

const seed = async () =>
  await fixture.service.create({
    name: 'Cable clip',
    prompt: 'a clip for a 6mm cable',
    source: SAMPLE_SCAD,
  });

describe('static assets', () => {
  it('serves the editor page with a locked-down CSP', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const csp = response.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.ok(!csp.includes('unsafe-inline'), 'the UI must not need inline script or style');

    const html = await response.text();
    assert.match(html, /<textarea id="source"/);
    assert.match(html, /Export STL/);
    assert.match(html, /Export 3MF/);
    assert.match(html, /Render preview/);
    assert.ok(!/https?:\/\/(?!localhost)/.test(html), 'no third-party assets');
  });

  it('serves dependency-free CSS and JS', async () => {
    for (const [path, type] of [
      ['/app.css', /text\/css/],
      ['/app.js', /javascript/],
    ] as const) {
      const response = await get(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', type);
      const body = await response.text();
      assert.ok(body.length > 0);
      assert.ok(!body.includes('cdn.'), 'assets must be local');
    }
  });

  it('404s an unknown route', async () => {
    const response = await get('/nope');
    assert.equal(response.status, 404);
    const body = await readJson(response);
    assert.equal(body.error.code, 'NOT_FOUND');
  });
});

describe('project endpoints', () => {
  it('lists an empty workspace', async () => {
    const response = await get('/api/projects');
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), { projects: [] });
  });

  it('creates a project and returns it', async () => {
    const response = await post('/api/projects', {
      name: 'Cable clip',
      prompt: 'a clip for a 6mm cable',
      source: SAMPLE_SCAD,
    });

    assert.equal(response.status, 201);
    const project = await readJson(response);
    assert.equal(project.id, 'cable-clip');
    assert.equal(project.revision, 1);
    assert.equal(project.prompt, 'a clip for a 6mm cable');
    assert.equal(project.source, `${SAMPLE_SCAD}\n`);
  });

  it('rejects a create with fields missing or of the wrong type', async () => {
    const missing = await post('/api/projects', { name: 'x', prompt: 'y' });
    assert.equal(missing.status, 400);
    assert.equal((await readJson(missing)).error.code, 'INVALID_FIELD');

    const wrongType = await post('/api/projects', { name: 1, prompt: 'y', source: 'cube(1);' });
    assert.equal(wrongType.status, 400);
  });

  it('reads a project with its source and artifacts', async () => {
    const created = await seed();
    const response = await get(`/api/projects/${created.id}`);
    assert.equal(response.status, 200);

    const project = await readJson(response);
    assert.equal(project.source, `${SAMPLE_SCAD}\n`);
    assert.deepEqual(project.artifacts, []);
    assert.equal(project.revisions.length, 1);
  });

  it('404s an unknown project', async () => {
    const response = await get('/api/projects/ghost');
    assert.equal(response.status, 404);
    assert.equal((await readJson(response)).error.code, 'NOT_FOUND');
  });

  it('400s a project id that tries to traverse', async () => {
    const response = await get('/api/projects/..%2f..%2fetc');
    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).error.code, 'CONFIG_INVALID');
  });

  it('saves a new revision', async () => {
    const created = await seed();
    const response = await post(`/api/projects/${created.id}/save`, {
      source: 'cube([4, 4, 4]);',
      note: 'simplified',
    });

    assert.equal(response.status, 200);
    const project = await readJson(response);
    assert.equal(project.revision, 2);
    assert.equal(project.source, 'cube([4, 4, 4]);\n');
    assert.equal(project.prompt, 'a clip for a 6mm cable', 'the original prompt survives a save');
    assert.equal(project.revisions[1].note, 'simplified');
  });

  it('refuses a save whose source escapes the project directory', async () => {
    const created = await seed();
    const response = await post(`/api/projects/${created.id}/save`, {
      source: 'include <../../../etc/passwd>',
    });
    assert.equal(response.status, 400);
    assert.match((await readJson(response)).error.message, /must not escape/);
  });
});

describe('render and export endpoints', () => {
  it('renders previews and links the images', async () => {
    const created = await seed();
    const response = await post(`/api/projects/${created.id}/render`, {});
    assert.equal(response.status, 200);

    const result = await readJson(response);
    assert.equal(result.views.length, 4);
    assert.equal(result.views[0].artifact.href, `/api/projects/${created.id}/artifacts/preview-iso.png`);

    const image = await get(result.views[0].artifact.href);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.ok(Number(image.headers.get('content-length')) > 0);
  });

  it('renders only the requested views', async () => {
    const created = await seed();
    const response = await post(`/api/projects/${created.id}/render`, { views: ['top'] });
    const result = await readJson(response);
    assert.deepEqual(result.views.map((view: { view: string }) => view.view), ['top']);
  });

  it('rejects an unknown view name', async () => {
    const created = await seed();
    const response = await post(`/api/projects/${created.id}/render`, { views: ['back'] });
    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).error.code, 'INVALID_FIELD');
  });

  it('exports STL and 3MF and serves them as downloads', async () => {
    const created = await seed();
    for (const [format, type] of [
      ['stl', 'model/stl'],
      ['3mf', 'model/3mf'],
    ] as const) {
      const response = await post(`/api/projects/${created.id}/export`, { format });
      assert.equal(response.status, 200);
      const result = await readJson(response);
      assert.equal(result.artifact.name, `model.${format}`);

      const download = await get(result.artifact.href);
      assert.equal(download.status, 200);
      assert.equal(download.headers.get('content-type'), type);
    }
  });

  it('rejects an unsupported export format', async () => {
    const created = await seed();
    const response = await post(`/api/projects/${created.id}/export`, { format: 'obj' });
    assert.equal(response.status, 400);
    assert.match((await readJson(response)).error.message, /"format" must be one of: stl, 3mf/);
  });

  it('answers 503 with install guidance when OpenSCAD is missing', async () => {
    const created = await seed();
    fixture.runner.setStatus({
      available: false,
      reason: 'OpenSCAD was not found. Tried: openscad.',
      searched: ['openscad'],
    });

    const response = await post(`/api/projects/${created.id}/render`, {});
    assert.equal(response.status, 503);
    const body = await readJson(response);
    assert.equal(body.error.code, 'TOOL_UNAVAILABLE');
    assert.match(body.error.message, /not found/);
  });

  it('answers 422 with the compiler diagnostics when the model does not compile', async () => {
    const created = await seed();
    fixture.runner.setBehaviour(() => ({
      ok: false,
      exitCode: 1,
      stderr: 'ERROR: Parser error: syntax error in file model.scad, line 4\n',
    }));

    const response = await post(`/api/projects/${created.id}/export`, { format: 'stl' });
    assert.equal(response.status, 422);
    const body = await readJson(response);
    assert.equal(body.error.code, 'RENDER_FAILED');
    assert.match(body.error.message, /Parser error/);
  });

  it('reports the toolchain status', async () => {
    const response = await get('/api/toolchain');
    assert.equal(response.status, 200);
    const status = await readJson(response);
    assert.equal(status.available, true);
    assert.equal(status.version, '2021.01');
  });
});

describe('artifact serving', () => {
  it('404s an artifact that has not been built', async () => {
    const created = await seed();
    const response = await get(`/api/projects/${created.id}/artifacts/model.stl`);
    assert.equal(response.status, 404);
  });

  it('refuses to serve anything outside the build directory', async () => {
    const created = await seed();
    for (const name of ['..%2Fmodel.scad', '..%2F..%2Fproject.json', '.env']) {
      const response = await get(`/api/projects/${created.id}/artifacts/${name}`);
      assert.ok(
        response.status === 400 || response.status === 404,
        `expected ${name} to be refused, got ${response.status}`,
      );
      assert.notEqual(response.status, 200);
    }
  });
});

describe('request guards', () => {
  it('refuses a request addressed to a non-loopback host', async () => {
    // How a DNS-rebinding page reaches a loopback server: right address, wrong name.
    const response = await rawGet('/api/projects', 'printer.example.com');
    assert.equal(response.status, 403);
    assert.match(response.body, /HOST_NOT_ALLOWED/);
  });

  it('accepts the loopback spellings of Host', async () => {
    for (const host of [`localhost:${server.port}`, `127.0.0.1:${server.port}`, 'localhost']) {
      assert.equal((await rawGet('/api/projects', host)).status, 200);
    }
  });

  it('refuses a cross-origin request even when it reaches loopback', async () => {
    const response = await post(
      '/api/projects',
      { name: 'x', prompt: 'y', source: 'cube(1);' },
      { headers: { origin: 'https://evil.example.com' } },
    );
    assert.equal(response.status, 403);
    assert.equal((await readJson(response)).error.code, 'ORIGIN_NOT_ALLOWED');
  });

  it('allows a same-origin request from the editor page', async () => {
    const response = await post(
      '/api/projects',
      { name: 'x', prompt: 'y', source: 'cube(1);' },
      { headers: { origin: base } },
    );
    assert.equal(response.status, 201);
  });

  it('requires a JSON content type, blocking simple form posts', async () => {
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=x&prompt=y&source=cube(1);',
    });
    assert.equal(response.status, 415);
  });

  it('rejects a body above the limit', async () => {
    const response = await post('/api/projects', {
      name: 'big',
      prompt: 'big',
      source: `// ${'x'.repeat(100_000)}\ncube(1);`,
    });
    assert.equal(response.status, 413);
    assert.equal((await readJson(response)).error.code, 'PAYLOAD_TOO_LARGE');
  });

  it('rejects a malformed JSON body', async () => {
    const response = await fetch(`${base}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(response.status, 400);
    assert.equal((await readJson(response)).error.code, 'INVALID_JSON');
  });

  it('rejects methods it does not implement', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const response = await fetch(`${base}/api/projects/x`, { method });
      assert.equal(response.status, 405);
    }
  });

  it('exposes no printer routes at all', async () => {
    for (const path of [
      '/api/printer/status',
      '/api/print/start',
      '/api/gcode/upload',
      '/api/printer',
    ]) {
      assert.equal((await get(path)).status, 404);
      assert.equal((await post(path, {})).status, 404);
    }
  });
});

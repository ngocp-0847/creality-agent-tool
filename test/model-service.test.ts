import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import { defineModelConfig } from '../src/model/config.js';
import { PREVIEW_VIEWS, type ExportFormat, type PreviewView } from '../src/model/types.js';
import {
  createModelFixture,
  FakeOpenScadRunner,
  SAMPLE_SCAD,
  type ModelFixture,
} from './model-helpers.js';

let fixture: ModelFixture;

beforeEach(async () => {
  fixture = await createModelFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

const seed = async () =>
  await fixture.service.create({
    name: 'Cable clip',
    prompt: 'a clip for a 6mm cable',
    source: SAMPLE_SCAD,
  });

describe('ModelService.renderPreview', () => {
  it('renders every standard view by default', async () => {
    const project = await seed();
    const result = await fixture.service.renderPreview({ id: project.id });

    assert.deepEqual(result.views.map((view) => view.view), [...PREVIEW_VIEWS]);
    assert.equal(result.revision, 1);
    assert.equal(fixture.runner.calls.length, PREVIEW_VIEWS.length);

    for (const rendered of result.views) {
      assert.equal(rendered.artifact.contentType, 'image/png');
      assert.equal(rendered.artifact.name, `preview-${rendered.view}.png`);
      assert.ok(rendered.artifact.bytes > 0);
    }
  });

  it('builds an argument vector with a camera per view and no shell string', async () => {
    const project = await seed();
    await fixture.service.renderPreview({ id: project.id, views: ['iso'] });

    const call = fixture.runner.calls[0];
    assert.ok(call);
    assert.ok(call.args.includes('-o'));
    assert.ok(call.args.some((arg) => arg.startsWith('--camera=')));
    assert.ok(call.args.includes('--viewall'));
    assert.ok(call.args.includes('--autocenter'));
    assert.ok(call.args.includes('--render'), 'CGAL render, so no GPU is needed');
    assert.ok(call.args.some((arg) => arg.endsWith('model.scad')));
    assert.equal(call.cwd, fixture.service.store.paths(project.id).buildDir);
  });

  it('honours a requested subset of views and de-duplicates it', async () => {
    const project = await seed();
    const result = await fixture.service.renderPreview({
      id: project.id,
      views: ['front', 'front', 'top'],
    });
    assert.deepEqual(result.views.map((view) => view.view), ['front', 'top']);
  });

  it('passes an explicit image size through to --imgsize', async () => {
    const project = await seed();
    await fixture.service.renderPreview({ id: project.id, views: ['top'], width: 320, height: 240 });
    assert.ok(fixture.runner.calls[0]?.args.includes('--imgsize=320,240'));
  });

  it('refuses an unknown view or an out-of-range size', async () => {
    const project = await seed();
    await assert.rejects(
      fixture.service.renderPreview({
        id: project.id,
        views: ['back'] as unknown as PreviewView[],
      }),
      /Unknown view "back"/,
    );
    await assert.rejects(
      fixture.service.renderPreview({ id: project.id, width: 10 }),
      /width must be an integer between 160 and 2048/,
    );
    await assert.rejects(
      fixture.service.renderPreview({ id: project.id, height: 99999 }),
      /height must be an integer between 160 and 2048/,
    );
  });

  it('surfaces a clear TOOL_UNAVAILABLE when OpenSCAD is missing', async () => {
    const project = await seed();
    fixture.runner.setStatus({
      available: false,
      reason: 'OpenSCAD was not found. Tried: openscad.',
      searched: ['openscad'],
    });

    await assert.rejects(
      fixture.service.renderPreview({ id: project.id }),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'TOOL_UNAVAILABLE');
        assert.match(error.message, /not found/);
        assert.equal(error.details?.['envKey'], 'CREALITY_OPENSCAD_PATH');
        return true;
      },
    );
    assert.equal(fixture.runner.calls.length, 0, 'must not spawn when unavailable');
  });

  it('reports compiler diagnostics on failure and leaves no partial artifact', async () => {
    const project = await seed();
    fixture.runner.setBehaviour(() => ({
      ok: false,
      exitCode: 1,
      stderr: 'ERROR: Parser error: syntax error in file model.scad, line 4\nnoise\n',
    }));

    await assert.rejects(fixture.service.renderPreview({ id: project.id }), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'RENDER_FAILED');
      assert.match(error.message, /Parser error/);
      assert.match(error.message, /exit 1/);
      return true;
    });

    const buildDir = fixture.service.store.paths(project.id).buildDir;
    assert.deepEqual(await readdir(buildDir), []);
  });

  it('reports a timeout as a timeout, with advice', async () => {
    const project = await seed();
    fixture.runner.setBehaviour(() => ({
      ok: false,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      durationMs: 60_000,
    }));

    await assert.rejects(fixture.service.renderPreview({ id: project.id }), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'RENDER_FAILED');
      assert.match(error.message, /timed out after 60000ms/);
      assert.match(error.message, /CREALITY_OPENSCAD_TIMEOUT_MS/);
      assert.equal(error.details?.['timedOut'], true);
      return true;
    });
  });

  it('carries non-fatal warnings through, de-duplicated', async () => {
    const project = await seed();
    fixture.runner.setBehaviour(() => ({
      stderr: 'WARNING: Object may not be a valid 2-manifold\nsome other chatter\n',
    }));

    const result = await fixture.service.renderPreview({ id: project.id, views: ['iso', 'top'] });
    assert.deepEqual(result.warnings, ['WARNING: Object may not be a valid 2-manifold']);
  });

  it('reports NOT_FOUND before it ever looks for OpenSCAD', async () => {
    await assert.rejects(fixture.service.renderPreview({ id: 'ghost' }), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    });
  });
});

describe('ModelService.export', () => {
  it('exports STL into the build directory', async () => {
    const project = await seed();
    const result = await fixture.service.export({ id: project.id, format: 'stl' });

    assert.equal(result.format, 'stl');
    assert.equal(result.artifact.name, 'model.stl');
    assert.equal(result.artifact.kind, 'export');
    assert.equal(result.artifact.contentType, 'model/stl');
    assert.deepEqual(await readdir(fixture.service.store.paths(project.id).buildDir), ['model.stl']);
  });

  it('lets OpenSCAD infer the format from the output extension', async () => {
    const project = await seed();
    await fixture.service.export({ id: project.id, format: '3mf' });

    const call = fixture.runner.calls[0];
    assert.ok(call);
    assert.match(FakeOpenScadRunner.outputPath(call), /\.3mf$/);
    assert.equal(
      (await readdir(fixture.service.store.paths(project.id).buildDir))[0],
      'model.3mf',
    );
  });

  it('refuses an unknown format', async () => {
    const project = await seed();
    await assert.rejects(
      fixture.service.export({ id: project.id, format: 'obj' as unknown as ExportFormat }),
      /Unknown export format "obj"/,
    );
  });

  it('surfaces a missing lib3mf as a render failure with the reason', async () => {
    const project = await seed();
    fixture.runner.setBehaviour(() => ({
      ok: false,
      exitCode: 1,
      stderr: 'ERROR: Export to 3MF format was not enabled when building the application.\n',
    }));

    await assert.rejects(
      fixture.service.export({ id: project.id, format: '3mf' }),
      /not enabled when building the application/,
    );
    assert.deepEqual(await readdir(fixture.service.store.paths(project.id).buildDir), []);
  });
});

describe('ModelService project lifecycle', () => {
  it('lists projects with their artifacts attached', async () => {
    const project = await seed();
    await fixture.service.export({ id: project.id, format: 'stl' });

    const [summary] = await fixture.service.list();
    assert.equal(summary?.id, project.id);
    assert.equal(summary?.prompt, 'a clip for a 6mm cable');
    assert.deepEqual(summary?.artifacts.map((artifact) => artifact.name), ['model.stl']);
  });

  it('discards stale artifacts when the source changes', async () => {
    const project = await seed();
    await fixture.service.renderPreview({ id: project.id });
    assert.equal((await fixture.service.read(project.id)).artifacts.length, PREVIEW_VIEWS.length);

    const updated = await fixture.service.update({ id: project.id, source: 'cube(5);' });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.artifacts, []);
    assert.deepEqual(await readdir(fixture.service.store.paths(project.id).dir), [
      'model.scad',
      'project.json',
    ]);
  });

  it('can render again after a save cleared the build directory', async () => {
    const project = await seed();
    await fixture.service.renderPreview({ id: project.id, views: ['iso'] });
    await fixture.service.update({ id: project.id, source: 'cube(5);' });

    const result = await fixture.service.renderPreview({ id: project.id, views: ['iso'] });
    assert.equal(result.views.length, 1);
    assert.equal(result.revision, 2);
  });

  it('reads an artifact back through the service', async () => {
    const project = await seed();
    await fixture.service.export({ id: project.id, format: 'stl' });
    const file = await fixture.service.readArtifact(project.id, 'model.stl');
    assert.equal(file.contentType, 'model/stl');
    assert.ok(file.bytes.byteLength > 0);
  });

  it('exposes toolchain status without touching a project', async () => {
    const status = await fixture.service.toolchain();
    assert.equal(status.available, true);
    assert.equal(status.version, '2021.01');
  });
});

describe('model configuration', () => {
  it('refuses to bind anywhere but loopback', () => {
    for (const host of ['0.0.0.0', '192.168.1.10', '::', 'example.com']) {
      assert.throws(() => defineModelConfig({ webHost: host }), (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'CONFIG_INVALID');
        assert.match(error.message, /localhost-only by design/);
        return true;
      });
    }
  });

  it('accepts the loopback spellings', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      assert.equal(defineModelConfig({ webHost: host }).webHost, host);
    }
  });

  it('bounds the process limits it hands to the runner', () => {
    assert.throws(() => defineModelConfig({ maxConcurrency: 0 }), /between 1 and 8/);
    assert.throws(() => defineModelConfig({ maxConcurrency: 99 }), /between 1 and 8/);
    assert.throws(() => defineModelConfig({ openscadTimeoutMs: 10 }), /between 1000 and 600000/);
    assert.throws(() => defineModelConfig({ webPort: 80 }), /between 1024 and 65535/);
  });
});

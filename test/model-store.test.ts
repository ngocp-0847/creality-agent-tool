import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import { sha256Hex } from '../src/hash.js';
import { ModelProjectStore, writeFileAtomic } from '../src/model/store.js';
import { SAMPLE_SCAD } from './model-helpers.js';

let root: string;
let counter = 0;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'creality-store-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

let workspace: string;
let store: ModelProjectStore;
let clock: Date;

beforeEach(() => {
  counter += 1;
  workspace = join(root, `ws-${counter}`);
  clock = new Date('2026-01-01T00:00:00.000Z');
  store = new ModelProjectStore({
    workspaceDir: workspace,
    maxSourceBytes: 64 * 1024,
    now: () => clock,
  });
});

const create = async (overrides: Record<string, unknown> = {}) =>
  await store.create({
    name: 'Cable clip 6mm',
    prompt: 'a clip that snaps onto a 6mm cable',
    source: SAMPLE_SCAD,
    ...overrides,
  });

describe('writeFileAtomic', () => {
  it('leaves no temporary files behind', async () => {
    const dir = join(root, 'atomic');
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'file.txt');

    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');

    assert.equal(await readFile(target, 'utf8'), 'second');
    assert.deepEqual(await readdir(dir), ['file.txt']);
  });

  it('creates missing parent directories', async () => {
    const target = join(root, 'deep', 'nested', 'file.txt');
    await writeFileAtomic(target, 'ok');
    assert.equal(await readFile(target, 'utf8'), 'ok');
  });

  it('replaces the previous content wholesale, never appending', async () => {
    const target = join(root, 'atomic-replace.txt');
    await writeFileAtomic(target, 'a-long-first-value');
    await writeFileAtomic(target, 'short');
    assert.equal(await readFile(target, 'utf8'), 'short');
  });
});

describe('ModelProjectStore.create', () => {
  it('writes model.scad and project.json into a project directory', async () => {
    const project = await create();

    assert.equal(project.id, 'cable-clip-6mm');
    assert.equal(project.revision, 1);
    assert.equal(project.name, 'Cable clip 6mm');
    assert.equal(project.prompt, 'a clip that snaps onto a 6mm cable');
    assert.equal(project.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(project.updatedAt, project.createdAt);
    assert.equal(project.sha256, sha256Hex(project.source));

    const paths = store.paths(project.id);
    assert.equal(await readFile(paths.sourcePath, 'utf8'), project.source);
    const metadata = JSON.parse(await readFile(paths.metadataPath, 'utf8'));
    assert.equal(metadata.prompt, project.prompt);
    assert.equal(metadata.revisions.length, 1);
  });

  it('records the first revision with the original prompt', async () => {
    const project = await create();
    assert.deepEqual(project.revisions, [
      {
        revision: 1,
        at: '2026-01-01T00:00:00.000Z',
        prompt: 'a clip that snaps onto a 6mm cable',
        sha256: project.sha256,
        bytes: project.bytes,
      },
    ]);
  });

  it('accepts an explicit id and refuses to overwrite an existing project', async () => {
    await create({ id: 'clip' });
    await assert.rejects(create({ id: 'clip' }), /already exists/);
  });

  it('de-duplicates derived ids instead of clobbering', async () => {
    const first = await create();
    const second = await create();
    assert.equal(first.id, 'cable-clip-6mm');
    assert.equal(second.id, 'cable-clip-6mm-2');
  });

  it('refuses an id that would escape the workspace', async () => {
    await assert.rejects(create({ id: '../escape' }), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'CONFIG_INVALID');
      return true;
    });
  });

  it('refuses an empty name, empty prompt, or invalid source', async () => {
    await assert.rejects(create({ name: '   ' }), /name must not be empty/);
    await assert.rejects(create({ prompt: '' }), /prompt must not be empty/);
    await assert.rejects(create({ source: '' }), /source must not be empty/);
    await assert.rejects(create({ source: 'include </etc/passwd>' }), /not an absolute one/);
  });

  it('refuses source above the configured ceiling', async () => {
    const small = new ModelProjectStore({ workspaceDir: workspace, maxSourceBytes: 64 });
    await assert.rejects(
      small.create({ name: 'big', prompt: 'p', source: `// ${'x'.repeat(500)}\ncube(1);` }),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
        return true;
      },
    );
  });
});

describe('ModelProjectStore.update', () => {
  it('appends a revision and moves the head forward', async () => {
    const project = await create();
    clock = new Date('2026-01-02T03:04:05.000Z');

    const updated = await store.update({
      id: project.id,
      source: 'cube([1, 2, 3]);',
      prompt: 'make it a box instead',
      note: 'switched to a cube',
    });

    assert.equal(updated.revision, 2);
    assert.equal(updated.source, 'cube([1, 2, 3]);\n');
    assert.equal(updated.updatedAt, '2026-01-02T03:04:05.000Z');
    assert.equal(updated.createdAt, project.createdAt, 'createdAt must not move');
    assert.equal(updated.revisions.length, 2);
    assert.equal(updated.revisions[1]?.prompt, 'make it a box instead');
    assert.equal(updated.revisions[1]?.note, 'switched to a cube');
    assert.equal(updated.sha256, sha256Hex(updated.source));
  });

  it('keeps the original prompt even when a revision carries its own', async () => {
    const project = await create();
    const updated = await store.update({
      id: project.id,
      source: 'cube(2);',
      prompt: 'make it a box instead',
    });

    assert.equal(updated.prompt, 'a clip that snaps onto a 6mm cable');
    assert.equal(updated.revisions[1]?.prompt, 'make it a box instead');
  });

  it('carries the project prompt into a revision that does not supply one', async () => {
    const project = await create();
    const updated = await store.update({ id: project.id, source: 'cube(2);' });
    assert.equal(updated.revisions[1]?.prompt, project.prompt);
  });

  it('persists across a fresh store instance', async () => {
    const project = await create();
    await store.update({ id: project.id, source: 'sphere(4);' });

    const reopened = new ModelProjectStore({ workspaceDir: workspace, maxSourceBytes: 64 * 1024 });
    const read = await reopened.read(project.id);
    assert.equal(read.revision, 2);
    assert.equal(read.source, 'sphere(4);\n');
  });

  it('refuses to update a project that does not exist', async () => {
    await assert.rejects(store.update({ id: 'nope', source: 'cube(1);' }), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    });
  });

  it('leaves the previous revision intact when the new source is refused', async () => {
    const project = await create();
    await assert.rejects(store.update({ id: project.id, source: 'include <../../x.scad>' }));

    const read = await store.read(project.id);
    assert.equal(read.revision, 1);
    assert.equal(read.source, project.source);
  });
});

describe('ModelProjectStore.list and read', () => {
  it('returns an empty list when the workspace does not exist yet', async () => {
    assert.deepEqual(await store.list(), []);
  });

  it('lists projects newest-updated first', async () => {
    await create({ id: 'older' });
    clock = new Date('2026-02-01T00:00:00.000Z');
    await create({ id: 'newer' });

    assert.deepEqual((await store.list()).map((project) => project.id), ['newer', 'older']);
  });

  it('ignores directories that are not projects', async () => {
    await create({ id: 'real' });
    await mkdir(join(workspace, 'Not A Project'), { recursive: true });
    await mkdir(join(workspace, 'empty-dir'), { recursive: true });
    await writeFile(join(workspace, 'stray.txt'), 'x');

    assert.deepEqual((await store.list()).map((project) => project.id), ['real']);
  });

  it('reports a corrupt project.json rather than returning nonsense', async () => {
    const project = await create();
    await writeFile(store.paths(project.id).metadataPath, '{not json');

    await assert.rejects(store.readMetadata(project.id), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'INTERNAL');
      assert.match(error.message, /not valid JSON/);
      return true;
    });
    // …and a corrupt project must not break the whole listing.
    assert.deepEqual(await store.list(), []);
  });

  it('reports NOT_FOUND for an unknown project', async () => {
    await assert.rejects(store.read('ghost'), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'NOT_FOUND');
      assert.match(error.message, /No model project "ghost"/);
      return true;
    });
  });

  it('tolerates metadata written by an older build', async () => {
    const project = await create();
    await writeFile(
      store.paths(project.id).metadataPath,
      JSON.stringify({ name: 'legacy', prompt: 'old prompt' }),
    );

    const metadata = await store.readMetadata(project.id);
    assert.equal(metadata.name, 'legacy');
    assert.equal(metadata.prompt, 'old prompt');
    assert.equal(metadata.revision, 1);
    assert.deepEqual(metadata.revisions, []);
  });
});

describe('ModelProjectStore artifacts', () => {
  it('publishes a build output atomically and describes it', async () => {
    const project = await create();
    const target = store.artifactTarget(project.id, 'preview-iso.png');
    assert.match(target.temporary, /\.part\.png$/, 'temp must keep the real extension');

    await store.ensureBuildDir(project.id);
    await writeFile(target.temporary, Buffer.alloc(2048));
    const artifact = await store.publishArtifact(project.id, 'preview-iso.png', target.temporary);

    assert.equal(artifact.name, 'preview-iso.png');
    assert.equal(artifact.kind, 'preview');
    assert.equal(artifact.bytes, 2048);
    assert.equal(artifact.contentType, 'image/png');
    assert.equal(artifact.href, `/api/projects/${project.id}/artifacts/preview-iso.png`);
  });

  it('classifies exports separately from previews', async () => {
    const project = await create();
    await store.ensureBuildDir(project.id);
    const target = store.artifactTarget(project.id, 'model.stl');
    await writeFile(target.temporary, 'solid\n');
    const artifact = await store.publishArtifact(project.id, 'model.stl', target.temporary);
    assert.equal(artifact.kind, 'export');
  });

  it('hides in-flight .part files from the artifact listing', async () => {
    const project = await create();
    await store.ensureBuildDir(project.id);
    const target = store.artifactTarget(project.id, 'preview-top.png');
    await writeFile(target.temporary, 'partial');

    assert.deepEqual(await store.listArtifacts(project.id), []);
  });

  it('returns an empty artifact list before anything is built', async () => {
    const project = await create();
    assert.deepEqual(await store.listArtifacts(project.id), []);
  });

  it('reads a built artifact back with its content type', async () => {
    const project = await create();
    await store.ensureBuildDir(project.id);
    const target = store.artifactTarget(project.id, 'model.3mf');
    await writeFile(target.temporary, 'zip-bytes');
    await store.publishArtifact(project.id, 'model.3mf', target.temporary);

    const file = await store.readArtifact(project.id, 'model.3mf');
    assert.equal(file.contentType, 'model/3mf');
    assert.equal(file.bytes.toString('utf8'), 'zip-bytes');
  });

  it('reports NOT_FOUND for an artifact that has not been built', async () => {
    const project = await create();
    await assert.rejects(store.readArtifact(project.id, 'model.stl'), (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, 'NOT_FOUND');
      return true;
    });
  });

  it('refuses to read outside the build directory', async () => {
    const project = await create();
    for (const name of ['../model.scad', '../../../etc/passwd', 'sub/file.png']) {
      await assert.rejects(store.readArtifact(project.id, name), (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.equal(error.code, 'CONFIG_INVALID');
        return true;
      });
    }
  });
});

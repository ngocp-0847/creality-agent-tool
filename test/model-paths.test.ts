import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import {
  artifactPath,
  assertContained,
  contentTypeFor,
  exportArtifactName,
  normalizeProjectId,
  previewArtifactName,
  projectPaths,
  slugifyProjectId,
} from '../src/model/paths.js';

const WORKSPACE = join(tmpdir(), 'creality-workspace-fixture');

function expectRejected(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(CrealityError.is(error), 'expected a CrealityError');
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.match(error.message, pattern);
    return true;
  });
}

describe('normalizeProjectId', () => {
  it('accepts plain slugs and lowercases them', () => {
    assert.equal(normalizeProjectId('cable-clip'), 'cable-clip');
    assert.equal(normalizeProjectId('  Cable_Clip2  '), 'cable_clip2');
    assert.equal(normalizeProjectId('a'), 'a');
  });

  it('refuses path separators', () => {
    expectRejected(() => normalizeProjectId('a/b'), /must be lowercase letters/);
    expectRejected(() => normalizeProjectId('a\\b'), /must be lowercase letters/);
  });

  it('refuses traversal in every spelling', () => {
    expectRejected(() => normalizeProjectId('..'), /must be lowercase letters/);
    expectRejected(() => normalizeProjectId('../etc'), /must be lowercase letters/);
    expectRejected(() => normalizeProjectId('..%2fetc'), /must be lowercase letters/);
    expectRejected(() => normalizeProjectId('.'), /must be lowercase letters/);
  });

  it('refuses absolute and drive paths', () => {
    expectRejected(() => normalizeProjectId('/etc/passwd'), /must be lowercase letters/);
    expectRejected(() => normalizeProjectId('C:\\Windows'), /must be lowercase letters/);
  });

  it('refuses control characters, NUL and spaces', () => {
    expectRejected(() => normalizeProjectId('a b'), /must be lowercase letters/);
    expectRejected(() => normalizeProjectId(`a${String.fromCharCode(0)}b`), /must be lowercase/);
  });

  it('refuses reserved Windows device names', () => {
    for (const name of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
      expectRejected(() => normalizeProjectId(name), /reserved device name/);
    }
  });

  it('refuses empty, over-long, and non-string ids', () => {
    expectRejected(() => normalizeProjectId(''), /must not be empty/);
    expectRejected(() => normalizeProjectId('   '), /must not be empty/);
    expectRejected(() => normalizeProjectId('a'.repeat(65)), /at most 64 characters/);
    expectRejected(() => normalizeProjectId(42), /must be a string/);
    expectRejected(() => normalizeProjectId(null), /must be a string/);
  });

  it('names the field it is complaining about', () => {
    expectRejected(() => normalizeProjectId('..', 'project'), /^project must be lowercase/);
  });
});

describe('slugifyProjectId', () => {
  it('derives a usable id from a human name', () => {
    assert.equal(slugifyProjectId('Cable clip 6mm'), 'cable-clip-6mm');
    assert.equal(slugifyProjectId('  Bracket / Mount  '), 'bracket-mount');
  });

  it('falls back to "model" when nothing usable survives', () => {
    assert.equal(slugifyProjectId('///'), 'model');
    assert.equal(slugifyProjectId(''), 'model');
    assert.equal(slugifyProjectId('...'), 'model');
  });

  it('never produces a reserved name', () => {
    assert.equal(slugifyProjectId('AUX'), 'model');
  });

  it('always produces something normalizeProjectId accepts', () => {
    for (const name of ['Ünïcode Pärt', '99 bottles', 'a'.repeat(200), '3D-Model!!!']) {
      assert.equal(normalizeProjectId(slugifyProjectId(name)), slugifyProjectId(name));
    }
  });
});

describe('projectPaths', () => {
  it('places every file inside the project directory', () => {
    const paths = projectPaths(WORKSPACE, 'cable-clip');
    const root = resolve(WORKSPACE, 'cable-clip');
    assert.equal(paths.dir, root);
    assert.equal(paths.sourcePath, join(root, 'model.scad'));
    assert.equal(paths.metadataPath, join(root, 'project.json'));
    assert.equal(paths.buildDir, join(root, 'build'));
  });

  it('refuses an id that would escape the workspace', () => {
    expectRejected(() => projectPaths(WORKSPACE, '../evil'), /must be lowercase letters/);
  });
});

describe('assertContained', () => {
  it('accepts a genuine descendant', () => {
    const root = resolve(WORKSPACE);
    assert.equal(assertContained(root, join(root, 'a', 'b')), join(root, 'a', 'b'));
  });

  it('rejects a sibling directory with a shared prefix', () => {
    const root = resolve(WORKSPACE);
    expectRejected(() => assertContained(root, `${root}-evil`), /escapes the model workspace/);
  });

  it('rejects a parent-escaping path', () => {
    const root = resolve(WORKSPACE);
    expectRejected(
      () => assertContained(root, join(root, '..', 'elsewhere')),
      /escapes the model workspace/,
    );
  });
});

describe('artifactPath', () => {
  it('resolves generated artifact names into the build directory', () => {
    const expected = join(resolve(WORKSPACE), 'clip', 'build', 'preview-iso.png');
    assert.equal(artifactPath(WORKSPACE, 'clip', previewArtifactName('iso')), expected);
    assert.equal(
      artifactPath(WORKSPACE, 'clip', exportArtifactName('3mf')),
      join(resolve(WORKSPACE), 'clip', 'build', 'model.3mf'),
    );
  });

  it('refuses traversal, separators and absolute artifact names', () => {
    for (const name of [
      '../../model.scad',
      '..',
      `sub${sep}file.png`,
      'sub/file.png',
      '/etc/passwd',
      'C:\\windows\\system32\\config',
      '',
      '.hidden',
    ]) {
      expectRejected(() => artifactPath(WORKSPACE, 'clip', name), /artifact must/);
    }
  });

  it('refuses artifact names that are not strings', () => {
    expectRejected(
      () => artifactPath(WORKSPACE, 'clip', undefined as unknown as string),
      /artifact must be a simple file name/,
    );
  });
});

describe('contentTypeFor', () => {
  it('maps the formats the editor serves', () => {
    assert.equal(contentTypeFor('preview-iso.png'), 'image/png');
    assert.equal(contentTypeFor('model.stl'), 'model/stl');
    assert.equal(contentTypeFor('model.3mf'), 'model/3mf');
  });

  it('falls back to octet-stream for anything else', () => {
    assert.equal(contentTypeFor('notes.bin'), 'application/octet-stream');
    assert.equal(contentTypeFor('noextension'), 'application/octet-stream');
  });
});

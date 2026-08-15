import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import { GCODE_EXTENSIONS, hasGcodeExtension, normalizeGcodePath } from '../src/gcode/paths.js';

function expectRejected(raw: string, pattern: RegExp): void {
  assert.throws(
    () => normalizeGcodePath(raw),
    (error: unknown) => {
      assert.ok(CrealityError.is(error), `expected CrealityError for ${JSON.stringify(raw)}`);
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.match(error.message, pattern);
      return true;
    },
    `expected ${JSON.stringify(raw)} to be rejected`,
  );
}

describe('hasGcodeExtension', () => {
  it('accepts every supported extension, case-insensitively', () => {
    for (const extension of GCODE_EXTENSIONS) {
      assert.equal(hasGcodeExtension(`part${extension}`), true);
      assert.equal(hasGcodeExtension(`part${extension.toUpperCase()}`), true);
    }
  });

  it('rejects non-G-code names', () => {
    assert.equal(hasGcodeExtension('notes.txt'), false);
    assert.equal(hasGcodeExtension('archive.gcode.zip'), false);
    assert.equal(hasGcodeExtension('gcode'), false);
  });
});

describe('normalizeGcodePath', () => {
  it('passes a plain filename through', () => {
    assert.equal(normalizeGcodePath('benchy.gcode'), 'benchy.gcode');
  });

  it('preserves subdirectories inside the gcodes root', () => {
    assert.equal(normalizeGcodePath('calibration/cube.gcode'), 'calibration/cube.gcode');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(normalizeGcodePath('  benchy.gcode  '), 'benchy.gcode');
  });

  it('normalises backslashes to forward slashes', () => {
    assert.equal(normalizeGcodePath('calibration\\cube.gcode'), 'calibration/cube.gcode');
  });

  it('strips redundant and leading-dot segments', () => {
    assert.equal(normalizeGcodePath('./a//b/./c.gcode'), 'a/b/c.gcode');
  });

  // --- traversal and escape attempts ---------------------------------------

  it('refuses parent-directory traversal', () => {
    expectRejected('../etc/passwd.gcode', /must not contain "\.\." segments/);
    expectRejected('a/../../b.gcode', /must not contain "\.\." segments/);
    expectRejected('a\\..\\b.gcode', /must not contain "\.\." segments/);
  });

  it('refuses absolute POSIX paths', () => {
    expectRejected('/etc/benchy.gcode', /must be printer-relative, not absolute/);
  });

  it('refuses Windows drive paths', () => {
    expectRejected('C:\\temp\\benchy.gcode', /must be printer-relative, not a drive path/);
    expectRejected('c:/temp/benchy.gcode', /must be printer-relative, not a drive path/);
  });

  it('refuses home-directory expansion', () => {
    expectRejected('~/benchy.gcode', /must not start with "~"/);
  });

  it('refuses UNC-style paths via the absolute-path rule', () => {
    expectRejected('\\\\server\\share\\benchy.gcode', /must be printer-relative, not absolute/);
  });

  // --- content hygiene ------------------------------------------------------

  it('refuses an empty or whitespace-only name', () => {
    expectRejected('', /must not be empty/);
    expectRejected('   ', /must not be empty/);
  });

  it('refuses control characters, including NUL truncation attempts', () => {
    expectRejected('benchy\u0000.gcode', /must not contain control characters/);
    expectRejected('ben\nchy.gcode', /must not contain control characters/);
    expectRejected('benchy\u007f.gcode', /must not contain control characters/);
  });

  it('refuses names beyond the length limit', () => {
    expectRejected(`${'a'.repeat(260)}.gcode`, /must be at most 255 characters/);
  });

  it('refuses a path that normalises to nothing', () => {
    expectRejected('./', /must not be empty|must name a file/);
  });

  it('refuses files that are not G-code', () => {
    expectRejected('benchy.txt', /must be a G-code file/);
    expectRejected('benchy', /must be a G-code file/);
  });

  it('names the offending field in the error', () => {
    assert.throws(
      () => normalizeGcodePath('bad.txt', { field: 'destination' }),
      (error: unknown) => {
        assert.ok(CrealityError.is(error));
        assert.match(error.message, /^destination must be a G-code file/);
        assert.deepEqual(error.details?.['field'], 'destination');
        return true;
      },
    );
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CrealityError } from '../src/errors.js';
import { validateScadSource } from '../src/model/source.js';

const OPTIONS = { maxBytes: 4096 } as const;

function expectRejected(source: string, pattern: RegExp, code = 'CONFIG_INVALID'): void {
  assert.throws(
    () => validateScadSource(source, OPTIONS),
    (error: unknown) => {
      assert.ok(CrealityError.is(error));
      assert.equal(error.code, code);
      assert.match(error.message, pattern);
      return true;
    },
    `expected ${JSON.stringify(source)} to be rejected`,
  );
}

describe('validateScadSource', () => {
  it('accepts ordinary parametric source', () => {
    const source = 'wall = 2;\ncube([10, 10, wall]);';
    assert.equal(validateScadSource(source, OPTIONS), `${source}\n`);
  });

  it('normalises CRLF and trailing whitespace so saves are byte-stable', () => {
    assert.equal(validateScadSource('cube(1);\r\ncube(2);\r\n\r\n  ', OPTIONS), 'cube(1);\ncube(2);\n');
  });

  it('allows project-relative includes', () => {
    const source = 'include <shared.scad>\nuse <lib/gears.scad>\nimport("part.stl");';
    assert.equal(validateScadSource(source, OPTIONS), `${source}\n`);
  });

  // --- reference containment -------------------------------------------------

  it('refuses includes that escape the project directory', () => {
    expectRejected('include <../../secrets.scad>', /must not escape the project directory/);
    expectRejected('use <..\\..\\secrets.scad>', /must not escape the project directory/);
  });

  it('refuses absolute include paths', () => {
    expectRejected('include </etc/passwd>', /not an absolute one/);
    expectRejected('use <C:\\Windows\\win.ini>', /not an absolute one/);
    expectRejected('include <\\\\server\\share\\x.scad>', /not an absolute one/);
  });

  it('refuses home-directory and URL references', () => {
    expectRejected('include <~/.ssh/id_rsa>', /must not reference a home directory/);
    expectRejected('include <https://example.com/evil.scad>', /must not reference a URL/);
  });

  it('applies the same rules to file-reading functions', () => {
    expectRejected('import("/etc/shadow");', /not an absolute one/);
    expectRejected("surface('../../../etc/hosts');", /must not escape the project directory/);
    expectRejected('import_stl("C:/Windows/system.ini");', /not an absolute one/);
  });

  // --- shape and size --------------------------------------------------------

  it('refuses empty, whitespace-only and non-string source', () => {
    expectRejected('', /must not be empty/);
    expectRejected('   \n  ', /must not be empty/);
    assert.throws(() => validateScadSource(undefined, OPTIONS), /must be a string/);
    assert.throws(() => validateScadSource({ cube: 1 }, OPTIONS), /must be a string/);
  });

  it('refuses NUL bytes', () => {
    expectRejected(`cube(1);${String.fromCharCode(0)}`, /must not contain NUL bytes/);
  });

  it('refuses source above the byte ceiling', () => {
    expectRejected(`// ${'x'.repeat(5000)}\ncube(1);`, /above the 4096 byte limit/, 'PAYLOAD_TOO_LARGE');
  });

  it('refuses a single absurdly long line', () => {
    assert.throws(
      () => validateScadSource(`cube(1); // ${'x'.repeat(5000)}`, { maxBytes: 1024 * 1024 }),
      /line longer than 4096 characters/,
    );
  });

  it('reports the field name it was given', () => {
    assert.throws(
      () => validateScadSource('', { maxBytes: 100, field: 'scad' }),
      (error: unknown) => CrealityError.is(error) && /^scad must not be empty/.test(error.message),
    );
  });
});

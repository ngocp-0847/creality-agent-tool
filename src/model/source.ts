/**
 * OpenSCAD source validation.
 *
 * OpenSCAD has no shell escape, but it does read files: `include <>`, `use <>`,
 * `import()`, `surface()` and friends resolve paths relative to the script — or
 * absolutely, if you let them. Since the source here arrives from an agent
 * acting on a user prompt, references are constrained to the project's own
 * sandbox: relative, no parent segments, no drive letters, no URLs.
 *
 * This is a lint, not a sandbox. It is the reason a render cannot be used to
 * read `/etc/shadow` into a PNG, but the real boundary is that the process runs
 * with a minimal environment in a per-project directory.
 */

import { CrealityError } from '../errors.js';

/** `include <path>` and `use <path>`. */
const ANGLE_INCLUDE = /\b(include|use)\s*<([^>]*)>/g;
/** `import("path")`, `surface("path")`, `import_stl("path")`, … */
const FILE_FUNCTION = /\b(import|import_stl|import_dxf|surface|dxf_[a-z_]+)\s*\(\s*(["'])(.*?)\2/g;

const MAX_LINE_LENGTH = 4_096;
const NUL = String.fromCharCode(0);

function reject(message: string, reference: string): never {
  throw new CrealityError('CONFIG_INVALID', message, {
    details: { field: 'source', reference },
  });
}

function assertSafeReference(reference: string, directive: string): void {
  const value = reference.trim();
  if (value === '') return;
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(value)) {
    reject(
      `${directive} must use a project-relative path, not an absolute one ("${value}").`,
      value,
    );
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    reject(`${directive} must not reference a URL or scheme ("${value}").`, value);
  }
  if (value.startsWith('~')) {
    reject(`${directive} must not reference a home directory ("${value}").`, value);
  }
  const segments = value.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) {
    reject(`${directive} must not escape the project directory ("${value}").`, value);
  }
}

export interface ValidateSourceOptions {
  readonly maxBytes: number;
  readonly field?: string;
}

/**
 * Validate `.scad` text and return it normalised (CRLF collapsed, trailing
 * newline ensured) so a save is byte-stable across platforms.
 */
export function validateScadSource(source: unknown, options: ValidateSourceOptions): string {
  const field = options.field ?? 'source';
  if (typeof source !== 'string') {
    throw new CrealityError('CONFIG_INVALID', `${field} must be a string.`, { details: { field } });
  }
  if (source.trim() === '') {
    throw new CrealityError('CONFIG_INVALID', `${field} must not be empty.`, { details: { field } });
  }

  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > options.maxBytes) {
    throw new CrealityError(
      'PAYLOAD_TOO_LARGE',
      `${field} is ${bytes} bytes, above the ${options.maxBytes} byte limit.`,
      { details: { field, bytes, maxBytes: options.maxBytes } },
    );
  }
  if (source.includes(NUL)) {
    throw new CrealityError('CONFIG_INVALID', `${field} must not contain NUL bytes.`, {
      details: { field },
    });
  }

  const normalized = `${source.replace(/\r\n/g, '\n').replace(/\s+$/, '')}\n`;

  for (const line of normalized.split('\n')) {
    if (line.length > MAX_LINE_LENGTH) {
      throw new CrealityError(
        'CONFIG_INVALID',
        `${field} has a line longer than ${MAX_LINE_LENGTH} characters.`,
        { details: { field, maxLineLength: MAX_LINE_LENGTH } },
      );
    }
  }

  for (const match of normalized.matchAll(ANGLE_INCLUDE)) {
    assertSafeReference(match[2] ?? '', `${match[1] ?? 'include'} <>`);
  }
  for (const match of normalized.matchAll(FILE_FUNCTION)) {
    assertSafeReference(match[3] ?? '', `${match[1] ?? 'import'}()`);
  }

  return normalized;
}

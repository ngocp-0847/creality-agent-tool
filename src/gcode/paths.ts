/**
 * G-code path hygiene.
 *
 * Moonraker addresses files by a relative path inside the `gcodes` root. Anything
 * that could escape that root, or that is not plausibly a G-code file, is refused
 * here rather than being handed to the printer to interpret.
 */

import { CrealityError } from '../errors.js';

export const GCODE_EXTENSIONS: readonly string[] = ['.gcode', '.gco', '.g', '.ufp', '.nc'];

/** Moonraker rejects longer paths, and long names are a red flag in agent input. */
const MAX_PATH_LENGTH = 255;

const DEL = 0x7f;
const FIRST_PRINTABLE = 0x20;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < FIRST_PRINTABLE || code === DEL) return true;
  }
  return false;
}

export function hasGcodeExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return GCODE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * Validate and normalise a printer-relative G-code path.
 *
 * Returns the normalised path (forward slashes, no leading `./` or `/`).
 * Throws `CONFIG_INVALID` for anything unsafe or implausible.
 */
export function normalizeGcodePath(raw: string, options: { readonly field?: string } = {}): string {
  const field = options.field ?? 'filename';
  if (typeof raw !== 'string') {
    throw new CrealityError('CONFIG_INVALID', `${field} must be a string.`, { details: { field } });
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CrealityError('CONFIG_INVALID', `${field} must not be empty.`, { details: { field } });
  }
  if (hasControlCharacters(trimmed)) {
    throw new CrealityError('CONFIG_INVALID', `${field} must not contain control characters.`, {
      details: { field },
    });
  }
  if (trimmed.length > MAX_PATH_LENGTH) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${field} must be at most ${MAX_PATH_LENGTH} characters (got ${trimmed.length}).`,
      { details: { field, maxLength: MAX_PATH_LENGTH } },
    );
  }

  const unified = trimmed.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(unified)) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${field} must be printer-relative, not a drive path.`,
      { details: { field, value: trimmed } },
    );
  }
  if (unified.startsWith('/')) {
    throw new CrealityError('CONFIG_INVALID', `${field} must be printer-relative, not absolute.`, {
      details: { field, value: trimmed },
    });
  }
  if (unified.startsWith('~')) {
    throw new CrealityError('CONFIG_INVALID', `${field} must not start with "~".`, {
      details: { field, value: trimmed },
    });
  }

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new CrealityError('CONFIG_INVALID', `${field} must not contain ".." segments.`, {
        details: { field, value: trimmed },
      });
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new CrealityError('CONFIG_INVALID', `${field} must name a file.`, {
      details: { field, value: trimmed },
    });
  }

  const normalized = segments.join('/');
  if (!hasGcodeExtension(normalized)) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${field} must be a G-code file (${GCODE_EXTENSIONS.join(', ')}); got "${normalized}".`,
      { details: { field, value: normalized, allowed: GCODE_EXTENSIONS } },
    );
  }

  return normalized;
}

/** Content hashing and canonical serialisation shared by confirmation and audit. */

import { createHash } from 'node:crypto';

export function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
    .digest('hex');
}

/**
 * Recursively order object keys so that structurally identical values serialise
 * identically. Confirmation fingerprints depend on this: `{a:1,b:2}` and
 * `{b:2,a:1}` must authorise the same action.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue;
      result[key] = canonicalize(entry);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

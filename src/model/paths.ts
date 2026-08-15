/**
 * Workspace path hygiene.
 *
 * Every filesystem path this package touches for a model project is derived
 * here, from a project id and a fixed set of file names. Nothing else is
 * allowed to join user input onto a path: an id that survives
 * {@link normalizeProjectId} cannot contain a separator, a dot segment, or a
 * drive letter, and {@link projectDir} still re-checks containment afterwards
 * so a future refactor cannot quietly reintroduce an escape.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import { CrealityError } from '../errors.js';
import type { ExportFormat, PreviewView } from './types.js';

/** Lowercase, separator-free, filesystem- and URL-safe. */
export const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export const SOURCE_FILE = 'model.scad';
export const METADATA_FILE = 'project.json';
export const BUILD_DIR = 'build';

/** Artefact names are generated, never accepted verbatim — but re-validated on read. */
export const ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Reserved DOS device names. Windows resolves these regardless of directory,
 * so a project called `aux` would produce paths that never become real files.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_unused, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `lpt${index + 1}`),
]);

const MAX_ID_LENGTH = 64;

function invalid(message: string, details: Record<string, unknown>): CrealityError {
  return new CrealityError('CONFIG_INVALID', message, { details });
}

/**
 * Validate a project id. Returns the lowercased id.
 *
 * Deliberately stricter than the filesystem: the id appears in paths, URLs and
 * MCP arguments, so it is restricted to the intersection of what all three
 * handle without escaping.
 */
export function normalizeProjectId(raw: unknown, field = 'project_id'): string {
  if (typeof raw !== 'string') {
    throw invalid(`${field} must be a string.`, { field });
  }
  const id = raw.trim().toLowerCase();
  if (id === '') {
    throw invalid(`${field} must not be empty.`, { field });
  }
  if (id.length > MAX_ID_LENGTH) {
    throw invalid(`${field} must be at most ${MAX_ID_LENGTH} characters (got ${id.length}).`, {
      field,
      maxLength: MAX_ID_LENGTH,
    });
  }
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw invalid(
      `${field} must be lowercase letters, digits, "-" or "_", starting and ending alphanumeric (got "${raw}").`,
      { field, value: raw },
    );
  }
  if (RESERVED_NAMES.has(id)) {
    throw invalid(`${field} "${id}" is a reserved device name.`, { field, value: id });
  }
  return id;
}

/** Derive a candidate id from a human name. Falls back to `model`. */
export function slugifyProjectId(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/g, '');
  if (slug === '' || !PROJECT_ID_PATTERN.test(slug) || RESERVED_NAMES.has(slug)) return 'model';
  return slug;
}

/** Absolute, symlink-free-enough workspace root. */
export function resolveWorkspace(dir: string): string {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw invalid('workspace directory must be a non-empty path.', { field: 'workspaceDir' });
  }
  return resolve(dir.trim());
}

/**
 * Assert that `candidate` really is inside `root`.
 *
 * The id pattern already makes traversal impossible; this is the belt to that
 * braces, and the thing that catches a caller who bypasses the pattern.
 */
export function assertContained(root: string, candidate: string, field = 'path'): string {
  const rootResolved = resolve(root);
  const target = resolve(candidate);
  if (target === rootResolved) return target;
  const rel = relative(rootResolved, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw invalid(`${field} escapes the model workspace.`, { field, root: rootResolved });
  }
  return target;
}

export interface ProjectPaths {
  readonly id: string;
  readonly dir: string;
  readonly sourcePath: string;
  readonly metadataPath: string;
  readonly buildDir: string;
}

export function projectPaths(workspaceDir: string, id: string): ProjectPaths {
  const root = resolveWorkspace(workspaceDir);
  const safeId = normalizeProjectId(id);
  const dir = assertContained(root, resolve(root, safeId), 'project directory');
  return {
    id: safeId,
    dir,
    sourcePath: assertContained(dir, resolve(dir, SOURCE_FILE), 'source path'),
    metadataPath: assertContained(dir, resolve(dir, METADATA_FILE), 'metadata path'),
    buildDir: assertContained(dir, resolve(dir, BUILD_DIR), 'build path'),
  };
}

/** Resolve a build artefact by name, re-validating the name and containment. */
export function artifactPath(workspaceDir: string, id: string, name: string): string {
  const { buildDir } = projectPaths(workspaceDir, id);
  if (typeof name !== 'string' || !ARTIFACT_NAME_PATTERN.test(name)) {
    throw invalid(`artifact must be a simple file name (got "${String(name)}").`, {
      field: 'artifact',
      value: name,
    });
  }
  if (name.includes('..')) {
    throw invalid('artifact must not contain "..".', { field: 'artifact', value: name });
  }
  return assertContained(buildDir, resolve(buildDir, name), 'artifact path');
}

export function previewArtifactName(view: PreviewView): string {
  return `preview-${view}.png`;
}

export function exportArtifactName(format: ExportFormat): string {
  return `model.${format}`;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.stl': 'model/stl',
  '.3mf': 'model/3mf',
  '.scad': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[name.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Model project storage.
 *
 * One directory per project, holding the two things worth keeping:
 *
 *   model.scad    the durable, editable, diffable source of truth
 *   project.json  who asked for it, when, and what changed since
 *
 * plus a `build/` directory of derived artefacts that can be deleted at any
 * time and rebuilt from the source.
 *
 * Writes are atomic: content goes to a temporary file in the same directory,
 * is flushed, and is then renamed over the target. A crash mid-save leaves the
 * previous revision intact rather than a half-written model.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { CrealityError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import {
  artifactPath,
  contentTypeFor,
  normalizeProjectId,
  projectPaths,
  resolveWorkspace,
  slugifyProjectId,
  SOURCE_FILE,
  type ProjectPaths,
} from './paths.js';
import { validateScadSource } from './source.js';
import type {
  ArtifactKind,
  ArtifactRef,
  ModelProject,
  ModelProjectMetadata,
  ModelRevision,
} from './types.js';

const MAX_NAME_LENGTH = 120;
const MAX_PROMPT_LENGTH = 8_000;
const MAX_NOTE_LENGTH = 500;
/** Enough history to explain a model; not so much that project.json grows unbounded. */
const MAX_REVISIONS = 100;
const MAX_PROJECTS = 500;
/** Marks a build output that has not been renamed into place yet. */
const PART_SUFFIX = '.part';

/** Write `data` to `filePath` atomically, creating parent directories. */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);

  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    // Rename is only atomic with respect to a durable file.
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function requireText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new CrealityError('CONFIG_INVALID', `${field} must be a string.`, { details: { field } });
  }
  const text = value.trim();
  if (text === '' && options.allowEmpty !== true) {
    throw new CrealityError('CONFIG_INVALID', `${field} must not be empty.`, { details: { field } });
  }
  if (text.length > maxLength) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${field} must be at most ${maxLength} characters (got ${text.length}).`,
      { details: { field, maxLength } },
    );
  }
  if (hasControlCharacters(text)) {
    throw new CrealityError('CONFIG_INVALID', `${field} must not contain control characters.`, {
      details: { field },
    });
  }
  return text;
}

export interface ModelProjectStoreOptions {
  readonly workspaceDir: string;
  readonly maxSourceBytes: number;
  readonly now?: () => Date;
}

export interface CreateProjectInput {
  /** Optional explicit id; otherwise derived from `name` and de-duplicated. */
  readonly id?: string;
  readonly name: string;
  /** The user request this model answers. Retained verbatim, forever. */
  readonly prompt: string;
  readonly source: string;
}

export interface UpdateProjectInput {
  readonly id: string;
  readonly source: string;
  /** The instruction behind this edit. The project's original prompt is untouched. */
  readonly prompt?: string;
  readonly note?: string;
}

export class ModelProjectStore {
  readonly #workspaceDir: string;
  readonly #maxSourceBytes: number;
  readonly #now: () => Date;

  constructor(options: ModelProjectStoreOptions) {
    this.#workspaceDir = resolveWorkspace(options.workspaceDir);
    this.#maxSourceBytes = options.maxSourceBytes;
    this.#now = options.now ?? ((): Date => new Date());
  }

  get workspaceDir(): string {
    return this.#workspaceDir;
  }

  paths(id: string): ProjectPaths {
    return projectPaths(this.#workspaceDir, id);
  }

  async list(): Promise<readonly ModelProjectMetadata[]> {
    let entries: string[];
    try {
      const dirents = await readdir(this.#workspaceDir, { withFileTypes: true });
      entries = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const projects: ModelProjectMetadata[] = [];
    for (const entry of entries) {
      // A directory that is not a valid project id was not created by us.
      let id: string;
      try {
        id = normalizeProjectId(entry);
      } catch {
        continue;
      }
      if (id !== entry) continue;
      try {
        projects.push(await this.readMetadata(id));
      } catch {
        // Unreadable or half-created project: skip rather than fail the listing.
        continue;
      }
    }

    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return projects;
  }

  async readMetadata(id: string): Promise<ModelProjectMetadata> {
    const { metadataPath, id: safeId } = this.paths(id);
    let raw: string;
    try {
      raw = await readFile(metadataPath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) throw notFound(safeId);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CrealityError(
        'INTERNAL',
        `project.json for "${safeId}" is not valid JSON; the project may be corrupt.`,
        { details: { id: safeId }, cause: error },
      );
    }
    return coerceMetadata(parsed, safeId);
  }

  async read(id: string): Promise<ModelProject> {
    const metadata = await this.readMetadata(id);
    const { sourcePath } = this.paths(id);
    let source: string;
    try {
      source = await readFile(sourcePath, 'utf8');
    } catch (error) {
      if (isNotFound(error)) throw notFound(metadata.id, 'model.scad is missing');
      throw error;
    }
    return { ...metadata, source };
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(this.paths(id).metadataPath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async create(input: CreateProjectInput): Promise<ModelProject> {
    const name = requireText(input.name, 'name', MAX_NAME_LENGTH);
    const prompt = requireText(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
    const source = validateScadSource(input.source, { maxBytes: this.#maxSourceBytes });

    const existing = await this.list();
    if (existing.length >= MAX_PROJECTS) {
      throw new CrealityError(
        'CONFIG_INVALID',
        `The workspace already holds ${existing.length} projects (limit ${MAX_PROJECTS}).`,
        { details: { limit: MAX_PROJECTS } },
      );
    }

    const id =
      input.id === undefined
        ? await this.#allocateId(slugifyProjectId(name))
        : normalizeProjectId(input.id);

    if (await this.exists(id)) {
      throw new CrealityError('CONFIG_INVALID', `A project named "${id}" already exists.`, {
        details: { id },
      });
    }

    const at = this.#now().toISOString();
    const sha256 = sha256Hex(source);
    const bytes = Buffer.byteLength(source, 'utf8');
    const metadata: ModelProjectMetadata = {
      id,
      name,
      prompt,
      createdAt: at,
      updatedAt: at,
      revision: 1,
      sourceFile: SOURCE_FILE,
      sha256,
      bytes,
      revisions: [{ revision: 1, at, prompt, sha256, bytes }],
    };

    const { dir, sourcePath, metadataPath, buildDir } = this.paths(id);
    await mkdir(dir, { recursive: true });
    await mkdir(buildDir, { recursive: true });
    await writeFileAtomic(sourcePath, source);
    await writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    return { ...metadata, source };
  }

  async update(input: UpdateProjectInput): Promise<ModelProject> {
    const current = await this.readMetadata(input.id);
    const source = validateScadSource(input.source, { maxBytes: this.#maxSourceBytes });
    const prompt =
      input.prompt === undefined
        ? current.prompt
        : requireText(input.prompt, 'prompt', MAX_PROMPT_LENGTH);
    const note =
      input.note === undefined ? undefined : requireText(input.note, 'note', MAX_NOTE_LENGTH);

    const at = this.#now().toISOString();
    const sha256 = sha256Hex(source);
    const bytes = Buffer.byteLength(source, 'utf8');
    const revision = current.revision + 1;

    const entry: ModelRevision = {
      revision,
      at,
      prompt,
      ...(note === undefined ? {} : { note }),
      sha256,
      bytes,
    };
    const revisions = [...current.revisions, entry].slice(-MAX_REVISIONS);

    const metadata: ModelProjectMetadata = {
      ...current,
      // The original prompt is deliberately not overwritten: it is the record
      // of what the project was for, not of the most recent tweak.
      updatedAt: at,
      revision,
      sha256,
      bytes,
      revisions,
    };

    const { sourcePath, metadataPath } = this.paths(current.id);
    await writeFileAtomic(sourcePath, source);
    await writeFileAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

    return { ...metadata, source };
  }

  // --- artefacts ------------------------------------------------------------

  /**
   * Path a renderer should write to, plus the temp path it writes first.
   *
   * The temporary keeps the final extension: OpenSCAD picks its export format
   * from the output file's suffix, so `.part` alone would leave it guessing.
   */
  artifactTarget(id: string, name: string): { readonly path: string; readonly temporary: string } {
    const path = artifactPath(this.#workspaceDir, id, name);
    return { path, temporary: `${path}.${randomUUID()}${PART_SUFFIX}${extname(name)}` };
  }

  async publishArtifact(id: string, name: string, temporary: string): Promise<ArtifactRef> {
    const { path } = this.artifactTarget(id, name);
    await rename(temporary, path);
    return await this.describeArtifact(id, name);
  }

  /** Create the build sandbox if a previous save cleared it. */
  async ensureBuildDir(id: string): Promise<string> {
    const { buildDir } = this.paths(id);
    await mkdir(buildDir, { recursive: true });
    return buildDir;
  }

  async describeArtifact(id: string, name: string): Promise<ArtifactRef> {
    const safeId = normalizeProjectId(id);
    const path = artifactPath(this.#workspaceDir, safeId, name);
    const info = await stat(path);
    return {
      name,
      kind: artifactKind(name),
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      contentType: contentTypeFor(name),
      href: `/api/projects/${safeId}/artifacts/${name}`,
    };
  }

  async listArtifacts(id: string): Promise<readonly ArtifactRef[]> {
    const { buildDir } = this.paths(id);
    let names: string[];
    try {
      const dirents = await readdir(buildDir, { withFileTypes: true });
      names = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }

    const artifacts: ArtifactRef[] = [];
    for (const name of names.sort()) {
      // An in-flight render is not an artefact until it has been renamed.
      if (name.includes(PART_SUFFIX)) continue;
      try {
        artifacts.push(await this.describeArtifact(id, name));
      } catch {
        continue;
      }
    }
    return artifacts;
  }

  async readArtifact(id: string, name: string): Promise<{
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly name: string;
  }> {
    const path = artifactPath(this.#workspaceDir, id, name);
    try {
      return { bytes: await readFile(path), contentType: contentTypeFor(name), name };
    } catch (error) {
      if (isNotFound(error)) {
        throw new CrealityError('NOT_FOUND', `Artifact "${name}" has not been built yet.`, {
          details: { id: normalizeProjectId(id), artifact: name },
        });
      }
      throw error;
    }
  }

  /** Find a free id by suffixing, so two "bracket" prompts do not collide. */
  async #allocateId(base: string): Promise<string> {
    if (!(await this.exists(base))) return base;
    for (let suffix = 2; suffix < 1_000; suffix += 1) {
      const candidate = normalizeProjectId(`${base.slice(0, 58)}-${suffix}`);
      if (!(await this.exists(candidate))) return candidate;
    }
    throw new CrealityError('CONFIG_INVALID', `Could not allocate an id based on "${base}".`, {
      details: { base },
    });
  }
}

const DEL = 0x7f;
const FIRST_PRINTABLE = 0x20;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x0a) continue; // prompts may legitimately be multi-line
    if (code < FIRST_PRINTABLE || code === DEL) return true;
  }
  return false;
}

function artifactKind(name: string): ArtifactKind {
  return name.startsWith('preview-') ? 'preview' : 'export';
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function notFound(id: string, detail?: string): CrealityError {
  return new CrealityError(
    'NOT_FOUND',
    `No model project "${id}"${detail === undefined ? '' : ` (${detail})`}. List projects to see what exists.`,
    { details: { id } },
  );
}

/** Read metadata defensively: the file is on disk and may predate this build. */
function coerceMetadata(value: unknown, id: string): ModelProjectMetadata {
  if (value === null || typeof value !== 'object') {
    throw new CrealityError('INTERNAL', `project.json for "${id}" is not an object.`, {
      details: { id },
    });
  }
  const raw = value as Record<string, unknown>;
  const text = (key: string, fallback: string): string =>
    typeof raw[key] === 'string' ? (raw[key]) : fallback;
  const count = (key: string, fallback: number): number =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) ? (raw[key]) : fallback;

  const revisions: ModelRevision[] = [];
  if (Array.isArray(raw['revisions'])) {
    for (const entry of raw['revisions'] as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const at = typeof record['at'] === 'string' ? record['at'] : undefined;
      if (at === undefined) continue;
      revisions.push({
        revision: typeof record['revision'] === 'number' ? record['revision'] : revisions.length + 1,
        at,
        prompt: typeof record['prompt'] === 'string' ? record['prompt'] : '',
        ...(typeof record['note'] === 'string' ? { note: record['note'] } : {}),
        sha256: typeof record['sha256'] === 'string' ? record['sha256'] : '',
        bytes: typeof record['bytes'] === 'number' ? record['bytes'] : 0,
      });
    }
  }

  const createdAt = text('createdAt', new Date(0).toISOString());
  return {
    id,
    name: text('name', id),
    prompt: text('prompt', ''),
    createdAt,
    updatedAt: text('updatedAt', createdAt),
    revision: count('revision', revisions.length === 0 ? 1 : revisions.length),
    sourceFile: SOURCE_FILE,
    sha256: text('sha256', ''),
    bytes: count('bytes', 0),
    revisions,
  };
}

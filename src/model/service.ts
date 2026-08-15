/**
 * CAD workspace service.
 *
 * The policy layer for model projects, mirroring {@link CrealityService}: the
 * MCP facade and the web editor are both thin shells over this class, and
 * neither may reach the store or the OpenSCAD runner directly.
 *
 * On the division of labour: this package never calls a cloud model. The agent
 * holds the conversation with the user and supplies OpenSCAD source; this
 * service persists it, renders it, and reports what OpenSCAD said. That keeps
 * the tool offline, deterministic, and free of an API-key dependency.
 */

import { rm } from 'node:fs/promises';

import { CrealityError } from '../errors.js';
import type { ModelConfig } from './config.js';
import {
  CliOpenScadRunner,
  openscadUnavailable,
  type OpenScadRunner,
  type OpenScadRunResult,
  type OpenScadStatus,
} from './openscad.js';
import { exportArtifactName, previewArtifactName } from './paths.js';
import {
  ModelProjectStore,
  type CreateProjectInput,
  type UpdateProjectInput,
} from './store.js';
import {
  EXPORT_FORMATS,
  PREVIEW_VIEWS,
  type ArtifactRef,
  type ExportFormat,
  type ExportResult,
  type ModelProject,
  type ModelProjectMetadata,
  type PreviewView,
  type RenderResult,
  type RenderedView,
} from './types.js';

/**
 * Camera angles as `tx,ty,tz,rx,ry,rz,dist`. Distance is left at 0 and paired
 * with `--viewall --autocenter` so framing adapts to the model instead of
 * clipping whatever does not fit a fixed distance.
 */
const VIEW_CAMERAS: Readonly<Record<PreviewView, string>> = {
  iso: '0,0,0,55,0,25,0',
  front: '0,0,0,90,0,0,0',
  top: '0,0,0,0,0,0,0',
  right: '0,0,0,90,0,90,0',
};

const DEFAULT_IMAGE_SIZE = { width: 720, height: 540 } as const;
const MIN_IMAGE_DIMENSION = 160;
const MAX_IMAGE_DIMENSION = 2_048;
/** How much OpenSCAD chatter to carry into an error message. */
const MAX_DIAGNOSTIC_LINES = 20;

export interface ModelServiceDeps {
  readonly store?: ModelProjectStore;
  readonly runner?: OpenScadRunner;
  readonly clock?: () => Date;
}

export interface RenderPreviewInput {
  readonly id: string;
  readonly views?: readonly PreviewView[];
  readonly width?: number;
  readonly height?: number;
}

export interface ExportModelInput {
  readonly id: string;
  readonly format: ExportFormat;
}

export interface ProjectSummary extends ModelProjectMetadata {
  readonly artifacts: readonly ArtifactRef[];
}

export interface ProjectDetail extends ModelProject {
  readonly artifacts: readonly ArtifactRef[];
}

export class ModelService {
  readonly #config: ModelConfig;
  readonly #store: ModelProjectStore;
  readonly #runner: OpenScadRunner;
  readonly #clock: () => Date;

  constructor(config: ModelConfig, deps: ModelServiceDeps = {}) {
    this.#config = config;
    this.#clock = deps.clock ?? ((): Date => new Date());
    this.#store =
      deps.store ??
      new ModelProjectStore({
        workspaceDir: config.workspaceDir,
        maxSourceBytes: config.maxSourceBytes,
        now: this.#clock,
      });
    this.#runner =
      deps.runner ??
      new CliOpenScadRunner({
        ...(config.openscadPath === undefined ? {} : { binaryPath: config.openscadPath }),
        timeoutMs: config.openscadTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        maxConcurrency: config.maxConcurrency,
      });
  }

  get config(): ModelConfig {
    return this.#config;
  }

  get store(): ModelProjectStore {
    return this.#store;
  }

  /** Whether OpenSCAD is usable, and if not, exactly what to do about it. */
  async toolchain(): Promise<OpenScadStatus> {
    return await this.#runner.status();
  }

  async list(): Promise<readonly ProjectSummary[]> {
    const projects = await this.#store.list();
    const summaries: ProjectSummary[] = [];
    for (const project of projects) {
      summaries.push({ ...project, artifacts: await this.#store.listArtifacts(project.id) });
    }
    return summaries;
  }

  async read(id: string): Promise<ProjectDetail> {
    const project = await this.#store.read(id);
    return { ...project, artifacts: await this.#store.listArtifacts(project.id) };
  }

  async create(input: CreateProjectInput): Promise<ProjectDetail> {
    const project = await this.#store.create(input);
    return { ...project, artifacts: [] };
  }

  /**
   * Save a new revision.
   *
   * Existing artefacts are discarded: a preview of the previous source is worse
   * than no preview, because it looks authoritative.
   */
  async update(input: UpdateProjectInput): Promise<ProjectDetail> {
    const project = await this.#store.update(input);
    await this.#clearArtifacts(project.id);
    return { ...project, artifacts: [] };
  }

  async readArtifact(
    id: string,
    name: string,
  ): Promise<{ readonly bytes: Buffer; readonly contentType: string; readonly name: string }> {
    return await this.#store.readArtifact(id, name);
  }

  // --- rendering ------------------------------------------------------------

  async renderPreview(input: RenderPreviewInput): Promise<RenderResult> {
    const project = await this.#store.read(input.id);
    const views = normalizeViews(input.views);
    const width = clampDimension(input.width, DEFAULT_IMAGE_SIZE.width, 'width');
    const height = clampDimension(input.height, DEFAULT_IMAGE_SIZE.height, 'height');
    await this.#assertAvailable();

    const { sourcePath } = this.#store.paths(project.id);
    const buildDir = await this.#store.ensureBuildDir(project.id);
    const rendered: RenderedView[] = [];
    const warnings: string[] = [];

    for (const view of views) {
      const name = previewArtifactName(view);
      const { temporary } = this.#store.artifactTarget(project.id, name);
      const result = await this.#runner.run({
        args: [
          '-o',
          temporary,
          `--imgsize=${width},${height}`,
          `--camera=${VIEW_CAMERAS[view]}`,
          '--viewall',
          '--autocenter',
          '--colorscheme=Cornfield',
          // CGAL rendering, so a preview does not depend on a GPU being present.
          '--render',
          sourcePath,
        ],
        cwd: buildDir,
      });

      if (!result.ok) {
        await rm(temporary, { force: true });
        throw renderFailure(`render the ${view} preview of "${project.id}"`, result);
      }

      const artifact = await this.#store.publishArtifact(project.id, name, temporary);
      rendered.push({ view, artifact, durationMs: result.durationMs });
      warnings.push(...diagnostics(result));
    }

    return {
      id: project.id,
      revision: project.revision,
      renderedAt: this.#clock().toISOString(),
      views: rendered,
      warnings: dedupe(warnings),
    };
  }

  async export(input: ExportModelInput): Promise<ExportResult> {
    const format = normalizeFormat(input.format);
    const project = await this.#store.read(input.id);
    await this.#assertAvailable();

    const { sourcePath } = this.#store.paths(project.id);
    const buildDir = await this.#store.ensureBuildDir(project.id);
    const name = exportArtifactName(format);
    // The temporary carries the real extension, so OpenSCAD picks the format.
    const { temporary } = this.#store.artifactTarget(project.id, name);
    const result = await this.#runner.run({
      args: ['-o', temporary, '--render', sourcePath],
      cwd: buildDir,
    });

    if (!result.ok) {
      await rm(temporary, { force: true });
      throw renderFailure(`export "${project.id}" as ${format.toUpperCase()}`, result);
    }

    const artifact = await this.#store.publishArtifact(project.id, name, temporary);
    return {
      id: project.id,
      revision: project.revision,
      format,
      exportedAt: this.#clock().toISOString(),
      artifact,
      durationMs: result.durationMs,
      warnings: dedupe(diagnostics(result)),
    };
  }

  async #assertAvailable(): Promise<void> {
    const status = await this.#runner.status();
    if (!status.available) throw openscadUnavailable(status);
  }

  async #clearArtifacts(id: string): Promise<void> {
    const { buildDir } = this.#store.paths(id);
    await rm(buildDir, { recursive: true, force: true });
  }
}

function normalizeViews(views: readonly PreviewView[] | undefined): readonly PreviewView[] {
  if (views === undefined || views.length === 0) return PREVIEW_VIEWS;
  const selected: PreviewView[] = [];
  for (const view of views) {
    if (!PREVIEW_VIEWS.includes(view)) {
      throw new CrealityError(
        'CONFIG_INVALID',
        `Unknown view "${String(view)}" (expected: ${PREVIEW_VIEWS.join(', ')}).`,
        { details: { field: 'views', allowed: PREVIEW_VIEWS } },
      );
    }
    if (!selected.includes(view)) selected.push(view);
  }
  return selected;
}

function normalizeFormat(format: ExportFormat): ExportFormat {
  if (!EXPORT_FORMATS.includes(format)) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `Unknown export format "${String(format)}" (expected: ${EXPORT_FORMATS.join(', ')}).`,
      { details: { field: 'format', allowed: EXPORT_FORMATS } },
    );
  }
  return format;
}

function clampDimension(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < MIN_IMAGE_DIMENSION || value > MAX_IMAGE_DIMENSION) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${field} must be an integer between ${MIN_IMAGE_DIMENSION} and ${MAX_IMAGE_DIMENSION}.`,
      { details: { field, min: MIN_IMAGE_DIMENSION, max: MAX_IMAGE_DIMENSION } },
    );
  }
  return value;
}

/** OpenSCAD warnings and errors, bounded, for display next to the editor. */
function diagnostics(result: OpenScadRunResult): string[] {
  return `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(ERROR|WARNING|TRACE)/i.test(line))
    .slice(0, MAX_DIAGNOSTIC_LINES);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function renderFailure(what: string, result: OpenScadRunResult): CrealityError {
  const lines = diagnostics(result);
  const detail =
    lines.length > 0
      ? lines.join('; ')
      : (result.stderr.trim() || result.stdout.trim() || 'no diagnostics').slice(0, 1_000);

  if (result.timedOut) {
    return new CrealityError(
      'RENDER_FAILED',
      `OpenSCAD timed out after ${result.durationMs}ms trying to ${what}. ` +
        'Simplify the model, lower $fn, or raise CREALITY_OPENSCAD_TIMEOUT_MS.',
      { details: { timedOut: true, durationMs: result.durationMs, diagnostics: lines } },
    );
  }

  return new CrealityError(
    'RENDER_FAILED',
    `OpenSCAD could not ${what} (exit ${String(result.exitCode)}): ${detail}`,
    {
      details: {
        exitCode: result.exitCode,
        ...(result.signal === null ? {} : { signal: result.signal }),
        diagnostics: lines,
      },
    },
  );
}

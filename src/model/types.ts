/**
 * Types for the CAD workspace.
 *
 * The durable artefact of a model project is its OpenSCAD source. Everything
 * else — previews, meshes — is derived and can be deleted and rebuilt. Metadata
 * exists so a later agent (or a human) can answer "what was this asked to be?"
 * without reading the geometry.
 */

/** The canonical camera angles rendered by a preview pass. */
export const PREVIEW_VIEWS = ['iso', 'front', 'top', 'right'] as const;
export type PreviewView = (typeof PREVIEW_VIEWS)[number];

export const EXPORT_FORMATS = ['stl', '3mf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** One saved edit of the source. Append-only; the head is `revision`. */
export interface ModelRevision {
  readonly revision: number;
  readonly at: string;
  /** The instruction that produced this revision, verbatim. */
  readonly prompt: string;
  readonly note?: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ModelProjectMetadata {
  readonly id: string;
  readonly name: string;
  /**
   * The request that created the project, kept verbatim for the life of the
   * project. Per-revision instructions live in {@link ModelRevision.prompt}.
   */
  readonly prompt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly sourceFile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly revisions: readonly ModelRevision[];
}

/** Metadata plus the current source text. */
export interface ModelProject extends ModelProjectMetadata {
  readonly source: string;
}

export type ArtifactKind = 'preview' | 'export';

export interface ArtifactRef {
  /** Name within the project's build directory, e.g. `preview-iso.png`. */
  readonly name: string;
  readonly kind: ArtifactKind;
  readonly bytes: number;
  readonly modifiedAt: string;
  readonly contentType: string;
  /** Path the web UI can GET. */
  readonly href: string;
}

export interface RenderedView {
  readonly view: PreviewView;
  readonly artifact: ArtifactRef;
  readonly durationMs: number;
}

export interface RenderResult {
  readonly id: string;
  readonly revision: number;
  readonly renderedAt: string;
  readonly views: readonly RenderedView[];
  /** OpenSCAD diagnostics (bounded), worth showing even on success. */
  readonly warnings: readonly string[];
}

export interface ExportResult {
  readonly id: string;
  readonly revision: number;
  readonly format: ExportFormat;
  readonly exportedAt: string;
  readonly artifact: ArtifactRef;
  readonly durationMs: number;
  readonly warnings: readonly string[];
}

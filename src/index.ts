/**
 * creality-agent-tool — agent-native control for Creality K1-class printers.
 *
 * The library surface. {@link CrealityService} is the only object that talks to
 * a printer; everything else here is types, configuration, or a building block
 * the service composes.
 */

export { AuditLog, redactParams } from './audit.js';
export type { AuditEntry, AuditLogOptions, AuditOutcome, AuditRecord } from './audit.js';

export { DEFAULTS, ENV_KEYS, defineConfig, loadConfigFromEnv } from './config.js';
export type { ConfigInput, CrealityConfig } from './config.js';

export { ConfirmationStore, fingerprintAction } from './confirm.js';
export type {
  ConfirmationStoreOptions,
  ConsumeConfirmationInput,
  IssueConfirmationInput,
} from './confirm.js';

export { CrealityError, ERROR_CODES, configInvalid } from './errors.js';
export type { CrealityErrorOptions, ErrorCode, SerializedCrealityError } from './errors.js';

export { canonicalJson, canonicalize, sha256Hex } from './hash.js';

export { GCODE_EXTENSIONS, hasGcodeExtension, normalizeGcodePath } from './gcode/paths.js';
export {
  PREFLIGHT_CODES,
  assertPreflightOk,
  formatBytes,
  preflightGcode,
} from './gcode/preflight.js';
export type {
  PreflightBounds,
  PreflightCode,
  PreflightFinding,
  PreflightOptions,
  PreflightReport,
  PreflightSeverity,
} from './gcode/preflight.js';

export {
  MODEL_DEFAULTS,
  MODEL_ENV_KEYS,
  defineModelConfig,
  loadModelConfigFromEnv,
} from './model/config.js';
export type { ModelConfig, ModelConfigInput } from './model/config.js';

export {
  CliOpenScadRunner,
  Semaphore,
  childEnvironment,
  defaultCandidates,
  execute,
  openscadUnavailable,
} from './model/openscad.js';
export type {
  OpenScadRunOptions,
  OpenScadRunResult,
  OpenScadRunner,
  OpenScadStatus,
} from './model/openscad.js';

export {
  ARTIFACT_NAME_PATTERN,
  BUILD_DIR,
  METADATA_FILE,
  PROJECT_ID_PATTERN,
  SOURCE_FILE,
  artifactPath,
  assertContained,
  contentTypeFor,
  exportArtifactName,
  normalizeProjectId,
  previewArtifactName,
  projectPaths,
  resolveWorkspace,
  slugifyProjectId,
} from './model/paths.js';
export type { ProjectPaths } from './model/paths.js';

export { ModelService } from './model/service.js';
export type {
  ExportModelInput,
  ModelServiceDeps,
  ProjectDetail,
  ProjectSummary,
  RenderPreviewInput,
} from './model/service.js';

export { validateScadSource } from './model/source.js';
export { ModelProjectStore, writeFileAtomic } from './model/store.js';
export type {
  CreateProjectInput,
  ModelProjectStoreOptions,
  UpdateProjectInput,
} from './model/store.js';

export { EXPORT_FORMATS, PREVIEW_VIEWS } from './model/types.js';
export type {
  ArtifactKind,
  ArtifactRef,
  ExportFormat,
  ExportResult,
  ModelProject,
  ModelProjectMetadata,
  ModelRevision,
  PreviewView,
  RenderResult,
  RenderedView,
} from './model/types.js';

export { MoonrakerClient } from './moonraker/client.js';
export type { UploadRequest } from './moonraker/client.js';
export { mapFileEntry, mapJob, mapMetadata, mapStatus } from './moonraker/mappers.js';

export { HttpClient, extractMoonrakerMessage } from './net/http.js';
export type { HttpClientDeps, HttpClientOptions, HttpRequestOptions } from './net/http.js';
export { PRIVATE_SCOPES, classifyAddress, expandIpv6, validateTarget } from './net/ssrf.js';
export type {
  AddressScope,
  ResolvedAddress,
  ValidatedTarget,
  ValidateTargetOptions,
} from './net/ssrf.js';

export { PRINTER_PROFILES, SUPPORTED_MODELS, getProfile, normalizeModel } from './profiles.js';
export type { PrinterProfile } from './profiles.js';

export { CrealityService, decodeContent } from './service.js';
export type {
  CrealityServiceDeps,
  ListFilesOptions,
  MutationOptions,
  StartPrintInput,
  UploadGcodeInput,
} from './service.js';

export { createModelWebHandler, startModelWebServer } from './web/server.js';
export type {
  ModelWebServerOptions,
  RequestHandler,
  RunningModelWebServer,
} from './web/server.js';

export { MUTATING_ACTIONS, isMutatingAction } from './types.js';
export type {
  ActionResult,
  Capabilities,
  ConfirmationTicket,
  GcodeFile,
  HeaterReading,
  JobStatus,
  MutatingAction,
  Position,
  PrinterModel,
  PrinterState,
  PrinterStatus,
} from './types.js';

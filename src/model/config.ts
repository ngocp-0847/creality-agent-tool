/**
 * CAD workspace configuration.
 *
 * Kept separate from {@link CrealityConfig}: the model workspace is local and
 * offline, so it must be usable without pointing at a printer, and a bad
 * printer URL must not stop someone editing a model.
 */

import { CrealityError } from '../errors.js';
import { resolveWorkspace } from './paths.js';

export interface ModelConfig {
  /** Root directory holding one sub-directory per project. */
  readonly workspaceDir: string;
  /** Explicit OpenSCAD binary. When unset, the runner probes known locations. */
  readonly openscadPath?: string;
  /** Wall-clock ceiling for a single OpenSCAD invocation. */
  readonly openscadTimeoutMs: number;
  /** Per-stream cap on captured stdout/stderr. Output beyond this is dropped. */
  readonly maxOutputBytes: number;
  /** Concurrent OpenSCAD processes. Rendering is CPU-bound; this is not a queue depth. */
  readonly maxConcurrency: number;
  /** Ceiling on a single .scad source. */
  readonly maxSourceBytes: number;
  /** Loopback interface the editor binds to. */
  readonly webHost: string;
  readonly webPort: number;
}

export const MODEL_ENV_KEYS = {
  workspaceDir: 'CREALITY_MODEL_WORKSPACE',
  openscadPath: 'CREALITY_OPENSCAD_PATH',
  openscadTimeoutMs: 'CREALITY_OPENSCAD_TIMEOUT_MS',
  maxOutputBytes: 'CREALITY_OPENSCAD_MAX_OUTPUT_BYTES',
  maxConcurrency: 'CREALITY_OPENSCAD_MAX_CONCURRENCY',
  maxSourceBytes: 'CREALITY_MODEL_MAX_SOURCE_BYTES',
  webHost: 'CREALITY_MODEL_WEB_HOST',
  webPort: 'CREALITY_MODEL_WEB_PORT',
} as const;

export const MODEL_DEFAULTS = {
  workspaceDir: './model-workspace',
  openscadTimeoutMs: 60_000,
  maxOutputBytes: 256 * 1024,
  maxConcurrency: 2,
  maxSourceBytes: 512 * 1024,
  webHost: '127.0.0.1',
  webPort: 7420,
} as const;

const LIMITS = {
  openscadTimeoutMs: [1_000, 600_000],
  maxOutputBytes: [1_024, 8 * 1024 * 1024],
  maxConcurrency: [1, 8],
  maxSourceBytes: [1_024, 8 * 1024 * 1024],
  webPort: [1_024, 65_535],
} as const satisfies Record<string, readonly [number, number]>;

/**
 * The editor exposes filesystem writes and process execution. It binds to
 * loopback only, and that is not configurable — a "just for a moment" bind to
 * 0.0.0.0 would hand those two capabilities to the LAN.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type ModelConfigInput = Partial<ModelConfig>;

function checkRange(name: keyof typeof LIMITS, value: number, source: string): number {
  const [min, max] = LIMITS[name];
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${source} must be an integer between ${min} and ${max} (got ${String(value)}).`,
      { details: { field: name, min, max } },
    );
  }
  return value;
}

function parseIntOption(
  raw: string | undefined,
  fallback: number,
  name: keyof typeof LIMITS,
  envKey: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  return checkRange(name, Number(raw), envKey);
}

/** Validate and normalise a fully-specified model config. */
export function defineModelConfig(input: ModelConfigInput = {}): ModelConfig {
  const workspaceDir = resolveWorkspace(input.workspaceDir ?? MODEL_DEFAULTS.workspaceDir);

  const webHost = (input.webHost ?? MODEL_DEFAULTS.webHost).trim();
  if (!LOOPBACK_HOSTS.has(webHost.toLowerCase())) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `webHost must be a loopback address (${[...LOOPBACK_HOSTS].join(', ')}); got "${webHost}". ` +
        'The model editor is localhost-only by design.',
      { details: { field: 'webHost', allowed: [...LOOPBACK_HOSTS] } },
    );
  }

  const openscadPath = input.openscadPath?.trim();

  return {
    workspaceDir,
    ...(openscadPath === undefined || openscadPath === '' ? {} : { openscadPath }),
    openscadTimeoutMs: checkRange(
      'openscadTimeoutMs',
      input.openscadTimeoutMs ?? MODEL_DEFAULTS.openscadTimeoutMs,
      'openscadTimeoutMs',
    ),
    maxOutputBytes: checkRange(
      'maxOutputBytes',
      input.maxOutputBytes ?? MODEL_DEFAULTS.maxOutputBytes,
      'maxOutputBytes',
    ),
    maxConcurrency: checkRange(
      'maxConcurrency',
      input.maxConcurrency ?? MODEL_DEFAULTS.maxConcurrency,
      'maxConcurrency',
    ),
    maxSourceBytes: checkRange(
      'maxSourceBytes',
      input.maxSourceBytes ?? MODEL_DEFAULTS.maxSourceBytes,
      'maxSourceBytes',
    ),
    webHost,
    webPort: checkRange('webPort', input.webPort ?? MODEL_DEFAULTS.webPort, 'webPort'),
  };
}

/** Build a model config from environment variables (see `.env.example`). */
export function loadModelConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelConfig {
  const workspaceDir = env[MODEL_ENV_KEYS.workspaceDir];
  const openscadPath = env[MODEL_ENV_KEYS.openscadPath];
  const webHost = env[MODEL_ENV_KEYS.webHost];

  return defineModelConfig({
    ...(workspaceDir === undefined || workspaceDir.trim() === '' ? {} : { workspaceDir }),
    ...(openscadPath === undefined || openscadPath.trim() === '' ? {} : { openscadPath }),
    ...(webHost === undefined || webHost.trim() === '' ? {} : { webHost }),
    openscadTimeoutMs: parseIntOption(
      env[MODEL_ENV_KEYS.openscadTimeoutMs],
      MODEL_DEFAULTS.openscadTimeoutMs,
      'openscadTimeoutMs',
      MODEL_ENV_KEYS.openscadTimeoutMs,
    ),
    maxOutputBytes: parseIntOption(
      env[MODEL_ENV_KEYS.maxOutputBytes],
      MODEL_DEFAULTS.maxOutputBytes,
      'maxOutputBytes',
      MODEL_ENV_KEYS.maxOutputBytes,
    ),
    maxConcurrency: parseIntOption(
      env[MODEL_ENV_KEYS.maxConcurrency],
      MODEL_DEFAULTS.maxConcurrency,
      'maxConcurrency',
      MODEL_ENV_KEYS.maxConcurrency,
    ),
    maxSourceBytes: parseIntOption(
      env[MODEL_ENV_KEYS.maxSourceBytes],
      MODEL_DEFAULTS.maxSourceBytes,
      'maxSourceBytes',
      MODEL_ENV_KEYS.maxSourceBytes,
    ),
    webPort: parseIntOption(
      env[MODEL_ENV_KEYS.webPort],
      MODEL_DEFAULTS.webPort,
      'webPort',
      MODEL_ENV_KEYS.webPort,
    ),
  });
}

/** Configuration loading and validation. */

import { CrealityError } from './errors.js';
import { getProfile, normalizeModel } from './profiles.js';
import type { PrinterModel } from './types.js';

export interface CrealityConfig {
  /** Moonraker base URL, e.g. `http://192.168.1.42:7125`. */
  readonly baseUrl: string;
  readonly model: PrinterModel;
  /** Moonraker API key, when the printer has authorisation enabled. */
  readonly apiKey?: string;
  readonly requestTimeoutMs: number;
  readonly uploadTimeoutMs: number;
  readonly maxUploadBytes: number;
  readonly confirmationTtlMs: number;
  /**
   * When false (default) the target must resolve to a loopback / private / link-local
   * address. Only enable if you deliberately expose a printer beyond your LAN.
   */
  readonly allowPublicNetwork: boolean;
  /** Optional hostname allowlist applied in addition to the address checks. */
  readonly allowedHosts: readonly string[];
  /** When true, mutating tools default to planning instead of acting. */
  readonly dryRunDefault: boolean;
  /** JSONL audit sink. When unset, audit records are kept in memory only. */
  readonly auditLogPath?: string;
}

export const ENV_KEYS = {
  baseUrl: 'CREALITY_PRINTER_URL',
  model: 'CREALITY_PRINTER_MODEL',
  apiKey: 'CREALITY_API_KEY',
  requestTimeoutMs: 'CREALITY_REQUEST_TIMEOUT_MS',
  uploadTimeoutMs: 'CREALITY_UPLOAD_TIMEOUT_MS',
  maxUploadBytes: 'CREALITY_MAX_UPLOAD_BYTES',
  confirmationTtlMs: 'CREALITY_CONFIRMATION_TTL_MS',
  allowPublicNetwork: 'CREALITY_ALLOW_PUBLIC_NETWORK',
  allowedHosts: 'CREALITY_ALLOWED_HOSTS',
  dryRunDefault: 'CREALITY_DRY_RUN',
  auditLogPath: 'CREALITY_AUDIT_LOG_PATH',
} as const;

export const DEFAULTS = {
  requestTimeoutMs: 10_000,
  uploadTimeoutMs: 120_000,
  /** Deliberately short: a confirmation is a here-and-now human intent, not a grant. */
  confirmationTtlMs: 120_000,
  maxUploadBytes: 128 * 1024 * 1024,
} as const;

const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 600_000;
const MIN_CONFIRMATION_TTL_MS = 5_000;
const MAX_CONFIRMATION_TTL_MS = 900_000;

export interface ConfigInput extends Partial<Omit<CrealityConfig, 'baseUrl' | 'model'>> {
  readonly baseUrl: string;
  /** Accepts loose spellings such as "K1 Max"; normalised via {@link normalizeModel}. */
  readonly model: PrinterModel | (string & {});
}

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  envKey: string,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${envKey} must be an integer between ${min} and ${max} (got "${raw}").`,
      { details: { envKey, min, max } },
    );
  }
  return value;
}

function parseBool(raw: string | undefined, fallback: boolean, envKey: string): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new CrealityError('CONFIG_INVALID', `${envKey} must be a boolean (got "${raw}").`, {
    details: { envKey },
  });
}

/** Validate and normalise a fully-specified config object. */
export function defineConfig(input: ConfigInput): CrealityConfig {
  const model = typeof input.model === 'string' ? normalizeModel(input.model) : input.model;
  const profile = getProfile(model);

  if (typeof input.baseUrl !== 'string' || input.baseUrl.trim() === '') {
    throw new CrealityError('CONFIG_INVALID', 'baseUrl is required.');
  }

  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const uploadTimeoutMs = input.uploadTimeoutMs ?? DEFAULTS.uploadTimeoutMs;
  const confirmationTtlMs = input.confirmationTtlMs ?? DEFAULTS.confirmationTtlMs;
  const maxUploadBytes = Math.min(
    input.maxUploadBytes ?? DEFAULTS.maxUploadBytes,
    profile.maxGcodeBytes,
  );

  for (const [name, value, min, max] of [
    ['requestTimeoutMs', requestTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS],
    ['uploadTimeoutMs', uploadTimeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS],
    ['confirmationTtlMs', confirmationTtlMs, MIN_CONFIRMATION_TTL_MS, MAX_CONFIRMATION_TTL_MS],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new CrealityError(
        'CONFIG_INVALID',
        `${name} must be an integer between ${min} and ${max} (got ${String(value)}).`,
        { details: { field: name, min, max } },
      );
    }
  }

  if (!Number.isInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new CrealityError('CONFIG_INVALID', 'maxUploadBytes must be a positive integer.');
  }

  const apiKey = input.apiKey?.trim();

  return {
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model,
    ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
    requestTimeoutMs,
    uploadTimeoutMs,
    maxUploadBytes,
    confirmationTtlMs,
    allowPublicNetwork: input.allowPublicNetwork ?? false,
    allowedHosts: input.allowedHosts ?? [],
    dryRunDefault: input.dryRunDefault ?? false,
    ...(input.auditLogPath === undefined || input.auditLogPath === ''
      ? {}
      : { auditLogPath: input.auditLogPath }),
  };
}

/** Build a config from environment variables (see `.env.example`). */
export function loadConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CrealityConfig {
  const baseUrl = env[ENV_KEYS.baseUrl];
  if (baseUrl === undefined || baseUrl.trim() === '') {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${ENV_KEYS.baseUrl} is required, e.g. "http://192.168.1.42:7125".`,
      { details: { envKey: ENV_KEYS.baseUrl } },
    );
  }
  const model = env[ENV_KEYS.model];
  if (model === undefined || model.trim() === '') {
    throw new CrealityError(
      'CONFIG_INVALID',
      `${ENV_KEYS.model} is required (k1 | k1c | k1-max | k2 | hi-combo).`,
      { details: { envKey: ENV_KEYS.model } },
    );
  }

  const allowedHosts = (env[ENV_KEYS.allowedHosts] ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== '');

  const apiKey = env[ENV_KEYS.apiKey];
  const auditLogPath = env[ENV_KEYS.auditLogPath];

  return defineConfig({
    baseUrl,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(auditLogPath === undefined ? {} : { auditLogPath }),
    requestTimeoutMs: parseIntInRange(
      env[ENV_KEYS.requestTimeoutMs],
      DEFAULTS.requestTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      ENV_KEYS.requestTimeoutMs,
    ),
    uploadTimeoutMs: parseIntInRange(
      env[ENV_KEYS.uploadTimeoutMs],
      DEFAULTS.uploadTimeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      ENV_KEYS.uploadTimeoutMs,
    ),
    maxUploadBytes: parseIntInRange(
      env[ENV_KEYS.maxUploadBytes],
      DEFAULTS.maxUploadBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      ENV_KEYS.maxUploadBytes,
    ),
    confirmationTtlMs: parseIntInRange(
      env[ENV_KEYS.confirmationTtlMs],
      DEFAULTS.confirmationTtlMs,
      MIN_CONFIRMATION_TTL_MS,
      MAX_CONFIRMATION_TTL_MS,
      ENV_KEYS.confirmationTtlMs,
    ),
    allowPublicNetwork: parseBool(
      env[ENV_KEYS.allowPublicNetwork],
      false,
      ENV_KEYS.allowPublicNetwork,
    ),
    allowedHosts,
    dryRunDefault: parseBool(env[ENV_KEYS.dryRunDefault], false, ENV_KEYS.dryRunDefault),
  });
}

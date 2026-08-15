/**
 * Service core.
 *
 * The single place where policy lives. Transports (MCP, a CLI, a library caller)
 * are thin shells over this class and must not be able to bypass it.
 *
 * Every mutating action passes through the same gate, in this order:
 *   1. shape      — arguments are validated and normalised
 *   2. capability — the model profile must support the action
 *   3. preflight  — for uploads, the program is inspected before transmission
 *   4. state      — the printer's current state must permit the action
 *   5. consent    — a fresh, single-use token bound to these exact parameters
 *   6. execute    — only now does anything reach the machine
 *   7. audit      — the attempt is recorded, whatever the outcome
 *
 * A dry run performs steps 1–4, mints the ticket for step 5, and stops. That is
 * the intended flow: plan, show a human the plan, then replay it with the token.
 */

import { AuditLog, type AuditOutcome, type AuditRecord } from './audit.js';
import { ConfirmationStore } from './confirm.js';
import type { CrealityConfig } from './config.js';
import { CrealityError } from './errors.js';
import {
  assertPreflightOk,
  formatBytes,
  preflightGcode,
  type PreflightReport,
} from './gcode/preflight.js';
import { normalizeGcodePath } from './gcode/paths.js';
import { sha256Hex } from './hash.js';
import { MoonrakerClient } from './moonraker/client.js';
import { mapFileEntry, mapMetadata, mapStatus } from './moonraker/mappers.js';
import { HttpClient, type HttpClientDeps } from './net/http.js';
import { getProfile, type PrinterProfile } from './profiles.js';
import type {
  ActionResult,
  Capabilities,
  ConfirmationTicket,
  GcodeFile,
  JobStatus,
  MutatingAction,
  PrinterStatus,
} from './types.js';

export interface CrealityServiceDeps extends HttpClientDeps {
  readonly audit?: AuditLog;
  readonly confirmations?: ConfirmationStore;
  readonly moonraker?: MoonrakerClient;
  /** Wall clock, injected for deterministic tests. */
  readonly clock?: () => Date;
}

/** Options common to every mutating call. */
export interface MutationOptions {
  /** Single-use ticket from a prior planning call. Required unless `dryRun`. */
  readonly confirmationToken?: string;
  /** Plan without acting. Defaults to the configured `dryRunDefault`. */
  readonly dryRun?: boolean;
}

export interface UploadGcodeInput extends MutationOptions {
  readonly filename: string;
  /** Raw bytes, or UTF-8 text, or a base64 string when `encoding` says so. */
  readonly content: Uint8Array | string;
  readonly encoding?: 'utf8' | 'base64';
  /** Begin printing immediately after a successful upload. */
  readonly startPrint?: boolean;
}

export interface StartPrintInput extends MutationOptions {
  readonly filename: string;
}

export interface ListFilesOptions {
  readonly limit?: number;
  /** Case-insensitive substring match on the path. */
  readonly search?: string;
}

/** Actions this tool refuses to expose at all, and why. */
const DENIED_ACTIONS: readonly { readonly action: string; readonly reason: string }[] = [
  {
    action: 'run_gcode_script',
    reason:
      'Arbitrary G-code execution (/printer/gcode/script) would bypass every preflight check in this tool.',
  },
  {
    action: 'emergency_stop',
    reason:
      'M112 requires a physical or firmware restart to clear; it must be a human action at the machine.',
  },
  {
    action: 'firmware_restart',
    reason: 'Restarting Klipper or the MCU is a maintenance action, not an agent action.',
  },
  {
    action: 'delete_file',
    reason: 'Destroying job history has no upside for an agent and is not reversible.',
  },
  {
    action: 'update_machine',
    reason: 'Firmware and software updates can brick a printer and are out of scope.',
  },
  {
    action: 'edit_printer_config',
    reason: 'SAVE_CONFIG rewrites printer.cfg and restarts Klipper.',
  },
  {
    action: 'machine_power_control',
    reason: 'Power cycling a heated printer unattended is a fire risk.',
  },
];

const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

export class CrealityService {
  readonly #config: CrealityConfig;
  readonly #profile: PrinterProfile;
  readonly #moonraker: MoonrakerClient;
  readonly #confirmations: ConfirmationStore;
  readonly #audit: AuditLog;
  readonly #clock: () => Date;

  constructor(config: CrealityConfig, deps: CrealityServiceDeps = {}) {
    this.#config = config;
    this.#profile = getProfile(config.model);
    this.#clock = deps.clock ?? ((): Date => new Date());

    this.#moonraker =
      deps.moonraker ??
      new MoonrakerClient(
        new HttpClient(
          {
            baseUrl: config.baseUrl,
            ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
            requestTimeoutMs: config.requestTimeoutMs,
            allowPublicNetwork: config.allowPublicNetwork,
            allowedHosts: config.allowedHosts,
          },
          {
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            ...(deps.now === undefined ? {} : { now: deps.now }),
            ...(deps.resolver === undefined ? {} : { resolver: deps.resolver }),
          },
        ),
      );

    this.#confirmations =
      deps.confirmations ??
      new ConfirmationStore({
        ttlMs: config.confirmationTtlMs,
        now: (): number => this.#clock().getTime(),
      });

    this.#audit =
      deps.audit ??
      new AuditLog({
        ...(config.auditLogPath === undefined ? {} : { filePath: config.auditLogPath }),
        now: this.#clock,
      });
  }

  get config(): CrealityConfig {
    return this.#config;
  }

  get profile(): PrinterProfile {
    return this.#profile;
  }

  get audit(): AuditLog {
    return this.#audit;
  }

  get confirmations(): ConfirmationStore {
    return this.#confirmations;
  }

  // --- read-only surface ----------------------------------------------------

  /** Static safety envelope for the configured model. No network access. */
  capabilities(): Capabilities {
    const profile = this.#profile;
    return {
      model: profile.model,
      displayName: profile.displayName,
      buildVolumeMm: profile.buildVolumeMm,
      maxExtruderTempC: profile.maxExtruderTempC,
      maxBedTempC: profile.maxBedTempC,
      ...(profile.maxChamberTempC === undefined ? {} : { maxChamberTempC: profile.maxChamberTempC }),
      heatedChamber: profile.heatedChamber,
      maxGcodeBytes: this.#config.maxUploadBytes,
      supportedActions: profile.supportedActions,
      deniedActions: DENIED_ACTIONS,
      dryRunDefault: this.#config.dryRunDefault,
      confirmationTtlMs: this.#config.confirmationTtlMs,
      compatibilityNotes: profile.compatibilityNotes,
    };
  }

  /** Capabilities enriched with the components the printer actually reports. */
  async capabilitiesLive(): Promise<Capabilities> {
    const base = this.capabilities();
    const serverInfo = await this.#moonraker.serverInfo();
    const components = serverInfo.components;
    if (components === undefined) return base;
    return { ...base, moonrakerComponents: components };
  }

  async status(): Promise<PrinterStatus> {
    const [printerInfo, serverInfo, query] = await Promise.all([
      this.#moonraker.printerInfo(),
      this.#moonraker.serverInfo(),
      this.#moonraker.queryObjects(),
    ]);
    return mapStatus({
      model: this.#config.model,
      printerInfo,
      serverInfo,
      query,
      sampledAt: this.#clock(),
    });
  }

  async job(): Promise<JobStatus> {
    const status = await this.status();
    return (
      status.job ?? {
        active: false,
        state: status.state,
        progress: 0,
      }
    );
  }

  async listFiles(options: ListFilesOptions = {}): Promise<readonly GcodeFile[]> {
    const limit = clampLimit(options.limit);
    const search = options.search?.trim().toLowerCase();
    const entries = await this.#moonraker.listGcodeFiles();

    const files: GcodeFile[] = [];
    for (const entry of entries) {
      const mapped = mapFileEntry(entry);
      if (mapped === undefined) continue;
      if (search !== undefined && search !== '' && !mapped.filename.toLowerCase().includes(search)) {
        continue;
      }
      files.push(mapped);
    }
    // Newest first: the file an operator just sliced is the one they mean.
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return files.slice(0, limit);
  }

  async fileMetadata(filename: string): Promise<GcodeFile> {
    const path = normalizeGcodePath(filename);
    return mapMetadata(path, await this.#moonraker.fileMetadata(path));
  }

  /**
   * Inspect a G-code program without uploading it. Pure and offline: this is
   * the cheap way for an agent to check a file before proposing anything.
   */
  preflight(input: {
    readonly filename: string;
    readonly content: Uint8Array | string;
    readonly encoding?: 'utf8' | 'base64';
  }): PreflightReport {
    const path = normalizeGcodePath(input.filename);
    const bytes = decodeContent(input.content, input.encoding);
    return preflightGcode(bytes, {
      filename: path,
      profile: this.#profile,
      maxBytes: this.#config.maxUploadBytes,
    });
  }

  auditTail(limit = 50): readonly AuditRecord[] {
    return this.#audit.recent(limit);
  }

  // --- mutating surface -----------------------------------------------------

  async uploadGcode(input: UploadGcodeInput): Promise<ActionResult> {
    const filename = normalizeGcodePath(input.filename);
    const bytes = decodeContent(input.content, input.encoding);
    const startPrint = input.startPrint ?? false;
    const digest = sha256Hex(bytes);

    if (bytes.byteLength > this.#config.maxUploadBytes) {
      throw await this.#deny(
        'upload_gcode',
        { filename, sizeBytes: bytes.byteLength, sha256: digest, startPrint },
        new CrealityError(
          'PAYLOAD_TOO_LARGE',
          `"${filename}" is ${formatBytes(bytes.byteLength)}, above the ${formatBytes(this.#config.maxUploadBytes)} upload limit.`,
          { details: { sizeBytes: bytes.byteLength, maxUploadBytes: this.#config.maxUploadBytes } },
        ),
        input,
      );
    }

    const report = preflightGcode(bytes, {
      filename,
      profile: this.#profile,
      maxBytes: this.#config.maxUploadBytes,
      sha256: digest,
    });

    const params = {
      filename,
      sizeBytes: bytes.byteLength,
      sha256: digest,
      startPrint,
    };

    const summary = startPrint
      ? `Upload ${filename} (${formatBytes(bytes.byteLength)}) and start printing it on the ${this.#profile.displayName}`
      : `Upload ${filename} (${formatBytes(bytes.byteLength)}) to the ${this.#profile.displayName}`;

    const details = {
      preflight: report,
      warnings: report.warnings,
      sizeBytes: bytes.byteLength,
      sha256: digest,
      startPrint,
    };

    return await this.#gate({
      action: 'upload_gcode',
      params,
      summary,
      details,
      options: input,
      precheck: async () => {
        if (!report.ok) assertPreflightOk(report);
        if (startPrint) await this.#assertCanStart();
      },
      execute: async () => {
        const result = await this.#moonraker.upload({
          filename,
          bytes,
          startPrint,
          timeoutMs: this.#config.uploadTimeoutMs,
        });
        return {
          uploadedPath: result.item?.path ?? filename,
          printStarted: result.print_started ?? startPrint,
        };
      },
    });
  }

  async startPrint(input: StartPrintInput): Promise<ActionResult> {
    const filename = normalizeGcodePath(input.filename);
    return await this.#gate({
      action: 'start_print',
      params: { filename },
      summary: `Start printing ${filename} on the ${this.#profile.displayName}`,
      details: { filename },
      options: input,
      precheck: async () => {
        await this.#assertFileExists(filename);
        await this.#assertCanStart();
      },
      execute: async () => {
        await this.#moonraker.startPrint(filename);
        return { filename };
      },
    });
  }

  async pausePrint(input: MutationOptions = {}): Promise<ActionResult> {
    return await this.#gate({
      action: 'pause_print',
      params: {},
      summary: 'Pause the running print',
      options: input,
      precheck: async () => {
        const status = await this.status();
        this.#assertState('pause_print', status, ['printing']);
      },
      execute: async () => {
        await this.#moonraker.pausePrint();
        return {};
      },
    });
  }

  async resumePrint(input: MutationOptions = {}): Promise<ActionResult> {
    return await this.#gate({
      action: 'resume_print',
      params: {},
      summary: 'Resume the paused print',
      options: input,
      precheck: async () => {
        const status = await this.status();
        this.#assertState('resume_print', status, ['paused']);
      },
      execute: async () => {
        await this.#moonraker.resumePrint();
        return {};
      },
    });
  }

  async cancelPrint(input: MutationOptions = {}): Promise<ActionResult> {
    return await this.#gate({
      action: 'cancel_print',
      params: {},
      summary: 'Cancel the current print (the partial object will be scrapped)',
      options: input,
      precheck: async () => {
        const status = await this.status();
        this.#assertState('cancel_print', status, ['printing', 'paused']);
      },
      execute: async () => {
        await this.#moonraker.cancelPrint();
        return {};
      },
    });
  }

  // --- the gate -------------------------------------------------------------

  async #gate(spec: {
    readonly action: MutatingAction;
    readonly params: Readonly<Record<string, unknown>>;
    readonly summary: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly options: MutationOptions;
    readonly precheck: () => Promise<void>;
    readonly execute: () => Promise<Record<string, unknown>>;
  }): Promise<ActionResult> {
    const { action, params, summary, options } = spec;
    const dryRun = options.dryRun ?? this.#config.dryRunDefault;
    const startedAt = Date.now();

    if (!this.#profile.supportedActions.includes(action)) {
      throw await this.#deny(
        action,
        params,
        new CrealityError(
          'UNSUPPORTED',
          `The ${this.#profile.displayName} profile does not support "${action}".`,
          { details: { action, model: this.#profile.model } },
        ),
        options,
      );
    }

    try {
      await spec.precheck();
    } catch (error) {
      throw await this.#deny(action, params, CrealityError.wrap(error), options);
    }

    if (dryRun) {
      const ticket = this.#confirmations.issue({ action, params, summary });
      await this.#record({
        action,
        outcome: 'planned',
        dryRun: true,
        summary,
        params,
        confirmation: ticket.fingerprint,
        durationMs: Date.now() - startedAt,
      });
      return {
        action,
        applied: false,
        dryRun: true,
        summary: `Planned (not applied): ${summary}. Confirm within ${Math.round(this.#config.confirmationTtlMs / 1000)}s by replaying this call with the confirmation token.`,
        details: { ...spec.details, plannedParams: params },
        confirmation: ticket,
      };
    }

    let ticket: ConfirmationTicket;
    try {
      ticket = this.#confirmations.consume({
        token: options.confirmationToken ?? '',
        action,
        params,
      });
    } catch (error) {
      throw await this.#deny(action, params, CrealityError.wrap(error), options);
    }

    let outcome: Record<string, unknown>;
    try {
      outcome = await spec.execute();
    } catch (error) {
      const wrapped = CrealityError.wrap(error, 'PRINTER_ERROR');
      await this.#record({
        action,
        outcome: 'failed',
        dryRun: false,
        summary,
        params,
        errorCode: wrapped.code,
        errorMessage: wrapped.message,
        confirmation: ticket.fingerprint,
        durationMs: Date.now() - startedAt,
      });
      throw wrapped;
    }

    await this.#record({
      action,
      outcome: 'applied',
      dryRun: false,
      summary,
      params,
      confirmation: ticket.fingerprint,
      durationMs: Date.now() - startedAt,
    });

    return {
      action,
      applied: true,
      dryRun: false,
      summary,
      details: { ...spec.details, ...outcome },
    };
  }

  /** Audit a refusal and hand back the error for the caller to throw. */
  async #deny(
    action: MutatingAction,
    params: Readonly<Record<string, unknown>>,
    error: CrealityError,
    options: MutationOptions,
  ): Promise<CrealityError> {
    await this.#record({
      action,
      outcome: 'denied',
      dryRun: options.dryRun ?? this.#config.dryRunDefault,
      summary: error.message,
      params,
      errorCode: error.code,
      errorMessage: error.message,
    });
    return error;
  }

  async #record(entry: {
    readonly action: MutatingAction;
    readonly outcome: AuditOutcome;
    readonly dryRun: boolean;
    readonly summary: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly errorCode?: CrealityError['code'];
    readonly errorMessage?: string;
    readonly confirmation?: string;
    readonly durationMs?: number;
  }): Promise<void> {
    await this.#audit.record(entry);
  }

  async #assertCanStart(): Promise<void> {
    const status = await this.status();
    if (status.job?.active === true || status.state === 'printing' || status.state === 'paused') {
      throw new CrealityError(
        'STATE_CONFLICT',
        `The printer is already ${status.state}${status.job?.filename === undefined ? '' : ` ("${status.job.filename}")`}. Cancel it before starting another print.`,
        { details: { state: status.state, job: status.job } },
      );
    }
    this.#assertState('start_print', status, ['ready', 'complete', 'cancelled', 'standby']);
  }

  #assertState(action: MutatingAction, status: PrinterStatus, allowed: readonly string[]): void {
    if (allowed.includes(status.state)) return;
    const jobState = status.job?.state;
    if (jobState !== undefined && allowed.includes(jobState)) return;
    throw new CrealityError(
      'STATE_CONFLICT',
      `"${action}" is not valid while the printer is "${status.state}" (expected: ${allowed.join(', ')}).`,
      { details: { action, state: status.state, allowed, stateText: status.stateText } },
    );
  }

  async #assertFileExists(filename: string): Promise<void> {
    try {
      await this.#moonraker.fileMetadata(filename);
    } catch (error) {
      if (CrealityError.is(error) && error.code === 'NOT_FOUND') {
        throw new CrealityError(
          'NOT_FOUND',
          `"${filename}" is not on the printer. Upload it first, or list files to find the right name.`,
          { details: { filename }, cause: error },
        );
      }
      throw error;
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)));
}

/** Normalise the several ways a caller may hand us file content. */
export function decodeContent(
  content: Uint8Array | string,
  encoding: 'utf8' | 'base64' = 'utf8',
): Uint8Array {
  if (typeof content !== 'string') return content;
  if (encoding === 'base64') {
    const compact = content.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
      throw new CrealityError('CONFIG_INVALID', 'content is not valid base64.');
    }
    const bytes = Buffer.from(compact, 'base64');
    // Buffer.from silently truncates malformed input; a round-trip check catches it.
    if (bytes.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
      throw new CrealityError('CONFIG_INVALID', 'content is not valid base64.');
    }
    return bytes;
  }
  return Buffer.from(content, 'utf8');
}

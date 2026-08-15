/** Domain types returned by the service core. Deliberately decoupled from Moonraker's wire shapes. */

export type PrinterModel = 'k1' | 'k1c' | 'k1-max' | 'k2';

export type PrinterState =
  | 'ready'
  | 'printing'
  | 'paused'
  | 'complete'
  | 'cancelled'
  | 'error'
  | 'startup'
  | 'shutdown'
  | 'offline'
  | 'unknown';

export interface HeaterReading {
  readonly current: number;
  readonly target: number;
  /** Fraction 0..1 of available power currently applied, when reported. */
  readonly power?: number;
}

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PrinterStatus {
  readonly model: PrinterModel;
  readonly state: PrinterState;
  /** Raw Klipper state string, preserved for diagnostics. */
  readonly stateText: string;
  readonly klipperVersion?: string;
  readonly moonrakerVersion?: string;
  readonly extruder?: HeaterReading;
  readonly bed?: HeaterReading;
  readonly chamber?: HeaterReading;
  readonly position?: Position;
  readonly homedAxes?: string;
  readonly fanSpeed?: number;
  readonly job?: JobStatus;
  readonly sampledAt: string;
}

export interface JobStatus {
  readonly active: boolean;
  readonly filename?: string;
  readonly state: PrinterState;
  /** 0..1 */
  readonly progress: number;
  readonly printDurationSec?: number;
  readonly totalDurationSec?: number;
  readonly estimatedRemainingSec?: number;
  readonly filamentUsedMm?: number;
  readonly message?: string;
}

export interface GcodeFile {
  readonly filename: string;
  readonly sizeBytes: number;
  readonly modified: string;
  readonly estimatedTimeSec?: number;
  readonly filamentTotalMm?: number;
  readonly firstLayerBedTemp?: number;
  readonly firstLayerExtruderTemp?: number;
  readonly slicer?: string;
  readonly objectHeightMm?: number;
}

export interface Capabilities {
  readonly model: PrinterModel;
  readonly displayName: string;
  readonly buildVolumeMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly maxExtruderTempC: number;
  readonly maxBedTempC: number;
  readonly maxChamberTempC?: number;
  readonly heatedChamber: boolean;
  readonly maxGcodeBytes: number;
  readonly supportedActions: readonly MutatingAction[];
  /** Actions the service will never expose, with the reason. */
  readonly deniedActions: readonly { readonly action: string; readonly reason: string }[];
  readonly moonrakerComponents?: readonly string[];
  readonly dryRunDefault: boolean;
  readonly confirmationTtlMs: number;
}

export const MUTATING_ACTIONS = [
  'upload_gcode',
  'start_print',
  'pause_print',
  'resume_print',
  'cancel_print',
] as const;

export type MutatingAction = (typeof MUTATING_ACTIONS)[number];

export function isMutatingAction(value: string): value is MutatingAction {
  return (MUTATING_ACTIONS as readonly string[]).includes(value);
}

export interface ConfirmationTicket {
  readonly token: string;
  readonly action: MutatingAction;
  readonly expiresAt: string;
  readonly ttlMs: number;
  /** SHA-256 of the canonicalised action + parameters this token authorises. */
  readonly fingerprint: string;
  readonly summary: string;
}

export interface ActionResult {
  readonly action: MutatingAction;
  readonly applied: boolean;
  readonly dryRun: boolean;
  /** Human-readable description of what was (or would be) done. */
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
  /**
   * Present on planning results: the ticket that authorises this exact call.
   * Show the summary to a human, then replay the call with `confirmationToken`.
   */
  readonly confirmation?: ConfirmationTicket;
}

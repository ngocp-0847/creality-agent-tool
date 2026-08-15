/** Translate Moonraker wire shapes into the stable domain types. */

import type {
  GcodeFile,
  HeaterReading,
  JobStatus,
  Position,
  PrinterModel,
  PrinterState,
  PrinterStatus,
} from '../types.js';
import type {
  RawFileEntry,
  RawFileMetadata,
  RawHeater,
  RawObjectQuery,
  RawPrinterInfo,
  RawServerInfo,
} from './types.js';

const JOB_STATES: Readonly<Record<string, PrinterState>> = {
  standby: 'ready',
  printing: 'printing',
  paused: 'paused',
  complete: 'complete',
  completed: 'complete',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  error: 'error',
};

const KLIPPY_STATES: Readonly<Record<string, PrinterState>> = {
  ready: 'ready',
  startup: 'startup',
  shutdown: 'shutdown',
  error: 'error',
  disconnected: 'offline',
};

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function heater(raw: RawHeater | undefined): HeaterReading | undefined {
  if (raw === undefined || typeof raw.temperature !== 'number') return undefined;
  return {
    current: round(raw.temperature, 1),
    target: round(raw.target ?? 0, 1),
    ...(typeof raw.power === 'number' ? { power: round(raw.power, 3) } : {}),
  };
}

function position(raw: readonly number[] | undefined): Position | undefined {
  if (raw === undefined || raw.length < 3) return undefined;
  const [x, y, z] = raw;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return undefined;
  return { x: round(x), y: round(y), z: round(z) };
}

export function mapJob(query: RawObjectQuery): JobStatus {
  const stats = query.status?.print_stats;
  const state = JOB_STATES[(stats?.state ?? '').toLowerCase()] ?? 'unknown';
  const rawProgress =
    query.status?.virtual_sdcard?.progress ?? query.status?.display_status?.progress ?? 0;
  const progress = Math.min(1, Math.max(0, typeof rawProgress === 'number' ? rawProgress : 0));
  const printDuration = stats?.print_duration;
  const active = state === 'printing' || state === 'paused';

  let estimatedRemainingSec: number | undefined;
  if (active && typeof printDuration === 'number' && progress > 0.001 && progress < 1) {
    estimatedRemainingSec = Math.max(0, Math.round((printDuration * (1 - progress)) / progress));
  }

  const filename = stats?.filename;
  const message = stats?.message;

  return {
    active,
    state,
    progress: round(progress, 4),
    ...(filename === undefined || filename === '' ? {} : { filename }),
    ...(typeof printDuration === 'number' ? { printDurationSec: Math.round(printDuration) } : {}),
    ...(typeof stats?.total_duration === 'number'
      ? { totalDurationSec: Math.round(stats.total_duration) }
      : {}),
    ...(estimatedRemainingSec === undefined ? {} : { estimatedRemainingSec }),
    ...(typeof stats?.filament_used === 'number'
      ? { filamentUsedMm: round(stats.filament_used, 1) }
      : {}),
    ...(message === undefined || message === '' ? {} : { message }),
  };
}

export function mapStatus(input: {
  readonly model: PrinterModel;
  readonly printerInfo: RawPrinterInfo;
  readonly serverInfo: RawServerInfo;
  readonly query: RawObjectQuery;
  readonly sampledAt: Date;
}): PrinterStatus {
  const { model, printerInfo, serverInfo, query, sampledAt } = input;
  const job = mapJob(query);

  const klippyState = (serverInfo.klippy_state ?? printerInfo.state ?? '').toLowerCase();
  const klippyMapped = KLIPPY_STATES[klippyState] ?? 'unknown';
  let state: PrinterState;
  if (serverInfo.klippy_connected === false) {
    state = 'offline';
  } else if (klippyMapped !== 'ready' && klippyMapped !== 'unknown') {
    state = klippyMapped;
  } else {
    state = job.state === 'unknown' ? klippyMapped : job.state;
  }

  const status = query.status;
  const chamber = heater(status?.['heater_generic chamber'] ?? status?.['temperature_sensor chamber']);
  const extruder = heater(status?.extruder);
  const bed = heater(status?.heater_bed);
  const pos = position(status?.toolhead?.position);
  const homedAxes = status?.toolhead?.homed_axes;
  const fanSpeed = status?.fan?.speed;

  return {
    model,
    state,
    stateText: printerInfo.state_message ?? serverInfo.klippy_state ?? printerInfo.state ?? 'unknown',
    ...(printerInfo.software_version === undefined
      ? {}
      : { klipperVersion: printerInfo.software_version }),
    ...(serverInfo.moonraker_version === undefined
      ? {}
      : { moonrakerVersion: serverInfo.moonraker_version }),
    ...(extruder === undefined ? {} : { extruder }),
    ...(bed === undefined ? {} : { bed }),
    ...(chamber === undefined ? {} : { chamber }),
    ...(pos === undefined ? {} : { position: pos }),
    ...(homedAxes === undefined ? {} : { homedAxes }),
    ...(typeof fanSpeed === 'number' ? { fanSpeed: round(fanSpeed, 3) } : {}),
    job,
    sampledAt: sampledAt.toISOString(),
  };
}

export function mapFileEntry(entry: RawFileEntry): GcodeFile | undefined {
  if (typeof entry.path !== 'string' || entry.path === '') return undefined;
  return {
    filename: entry.path,
    sizeBytes: typeof entry.size === 'number' ? Math.round(entry.size) : 0,
    modified: toIso(entry.modified),
  };
}

export function mapMetadata(filename: string, raw: RawFileMetadata): GcodeFile {
  return {
    filename: raw.filename ?? filename,
    sizeBytes: typeof raw.size === 'number' ? Math.round(raw.size) : 0,
    modified: toIso(raw.modified),
    ...(typeof raw.estimated_time === 'number'
      ? { estimatedTimeSec: Math.round(raw.estimated_time) }
      : {}),
    ...(typeof raw.filament_total === 'number'
      ? { filamentTotalMm: round(raw.filament_total, 1) }
      : {}),
    ...(typeof raw.first_layer_bed_temp === 'number'
      ? { firstLayerBedTemp: round(raw.first_layer_bed_temp, 1) }
      : {}),
    ...(typeof raw.first_layer_extr_temp === 'number'
      ? { firstLayerExtruderTemp: round(raw.first_layer_extr_temp, 1) }
      : {}),
    ...(raw.slicer === undefined ? {} : { slicer: raw.slicer }),
    ...(typeof raw.object_height === 'number'
      ? { objectHeightMm: round(raw.object_height, 2) }
      : {}),
  };
}

/** Moonraker reports mtimes as unix seconds. */
function toIso(modified: number | undefined): string {
  if (typeof modified !== 'number' || !Number.isFinite(modified)) return new Date(0).toISOString();
  return new Date(Math.round(modified * 1000)).toISOString();
}

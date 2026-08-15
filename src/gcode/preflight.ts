/**
 * G-code preflight.
 *
 * A static, read-only inspection of a G-code program run *before* anything is
 * sent to the printer. It answers one question: "is there anything in this file
 * that a machine should not be asked to do unattended?"
 *
 * It is intentionally conservative and intentionally not a simulator. It catches
 * the failure modes that are cheap to detect statically and expensive to discover
 * physically: temperatures beyond the model's envelope, motion outside the build
 * volume, and commands that reconfigure or restart the firmware mid-job. The
 * printer's own limits remain the final authority.
 *
 * The scan is streaming and bounded in memory, so a 512 MB program costs a
 * fixed-size buffer rather than a 512 MB string.
 */

import { CrealityError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import type { PrinterProfile } from '../profiles.js';

export type PreflightSeverity = 'error' | 'warning';

export const PREFLIGHT_CODES = [
  'EMPTY_FILE',
  'BINARY_CONTENT',
  'TOO_LARGE',
  'EXTRUDER_TEMP_TOO_HIGH',
  'BED_TEMP_TOO_HIGH',
  'CHAMBER_TEMP_TOO_HIGH',
  'CHAMBER_UNSUPPORTED',
  'OUT_OF_BOUNDS',
  'NEGATIVE_Z',
  'FIRMWARE_MUTATION',
  'FIRMWARE_RESTART',
  'EMERGENCY_STOP',
  'SHELL_COMMAND',
  'UNSAFE_MOTION',
  'COLD_EXTRUSION',
  'DRIVER_CURRENT',
  'NO_HOMING',
  'NO_EXTRUSION',
  'SCAN_TRUNCATED',
] as const;

export type PreflightCode = (typeof PREFLIGHT_CODES)[number];

export interface PreflightFinding {
  readonly code: PreflightCode;
  readonly severity: PreflightSeverity;
  readonly message: string;
  /** 1-based line number, when the finding is attributable to one line. */
  readonly line?: number;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PreflightBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly lineCount: number;
  readonly scannedLines: number;
  readonly truncated: boolean;
  readonly errors: readonly PreflightFinding[];
  readonly warnings: readonly PreflightFinding[];
  /** Highest commanded temperatures seen anywhere in the program. */
  readonly maxExtruderTempC?: number;
  readonly maxBedTempC?: number;
  readonly maxChamberTempC?: number;
  readonly bounds?: PreflightBounds;
  readonly homed: boolean;
  readonly extrudes: boolean;
  readonly slicer?: string;
  readonly estimatedTimeSec?: number;
  readonly summary: string;
}

export interface PreflightOptions {
  readonly filename: string;
  readonly profile: PrinterProfile;
  /** Hard byte ceiling; exceeding it is an error rather than a truncated scan. */
  readonly maxBytes: number;
  /** Stop scanning after this many lines and flag the report as truncated. */
  readonly maxScanLines?: number;
  /** Slack allowed outside the nominal build volume, in millimetres. */
  readonly boundsToleranceMm?: number;
  /** Pre-computed content digest; supplied by callers that already hashed the bytes. */
  readonly sha256?: string;
}

const DEFAULT_MAX_SCAN_LINES = 20_000_000;
const DEFAULT_BOUNDS_TOLERANCE_MM = 1;
const CHUNK_BYTES = 1 << 20;
/** Only the head of the file is sampled for NUL bytes; slicers emit text headers. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * Commands that reconfigure, restart, or step outside the firmware's safety
 * envelope. None of these belong in a sliced print job.
 */
interface DangerRule {
  readonly code: PreflightCode;
  readonly severity: PreflightSeverity;
  readonly message: string;
}

const EXTENDED_DANGERS: Readonly<Record<string, DangerRule>> = {
  SAVE_CONFIG: {
    code: 'FIRMWARE_MUTATION',
    severity: 'error',
    message: 'SAVE_CONFIG rewrites printer.cfg and restarts Klipper.',
  },
  RESTART: {
    code: 'FIRMWARE_RESTART',
    severity: 'error',
    message: 'RESTART interrupts the host mid-job.',
  },
  FIRMWARE_RESTART: {
    code: 'FIRMWARE_RESTART',
    severity: 'error',
    message: 'FIRMWARE_RESTART interrupts the MCU mid-job.',
  },
  RUN_SHELL_COMMAND: {
    code: 'SHELL_COMMAND',
    severity: 'error',
    message: 'RUN_SHELL_COMMAND executes arbitrary code on the printer host.',
  },
  FORCE_MOVE: {
    code: 'UNSAFE_MOTION',
    severity: 'error',
    message: 'FORCE_MOVE bypasses kinematic limits and homing state.',
  },
  SET_KINEMATIC_POSITION: {
    code: 'UNSAFE_MOTION',
    severity: 'error',
    message: 'SET_KINEMATIC_POSITION falsifies the toolhead position.',
  },
  SET_TMC_CURRENT: {
    code: 'DRIVER_CURRENT',
    severity: 'warning',
    message: 'SET_TMC_CURRENT changes stepper driver current.',
  },
  SET_PRESSURE_ADVANCE: {
    code: 'FIRMWARE_MUTATION',
    severity: 'warning',
    message: 'SET_PRESSURE_ADVANCE tunes extrusion behaviour at runtime.',
  },
};

const MCODE_DANGERS: Readonly<Record<number, DangerRule>> = {
  112: {
    code: 'EMERGENCY_STOP',
    severity: 'error',
    message: 'M112 triggers an emergency shutdown requiring a manual restart.',
  },
  302: {
    code: 'COLD_EXTRUSION',
    severity: 'error',
    message: 'M302 permits extrusion below the safe minimum temperature.',
  },
  500: {
    code: 'FIRMWARE_MUTATION',
    severity: 'warning',
    message: 'M500 persists settings to the printer configuration.',
  },
  502: {
    code: 'FIRMWARE_MUTATION',
    severity: 'error',
    message: 'M502 resets the printer configuration to factory defaults.',
  },
  997: {
    code: 'FIRMWARE_MUTATION',
    severity: 'error',
    message: 'M997 initiates a firmware update.',
  },
  906: {
    code: 'DRIVER_CURRENT',
    severity: 'warning',
    message: 'M906 changes stepper driver current.',
  },
};

interface ParsedLine {
  /** Uppercased leading token, e.g. `G1`, `M104`, `SET_HEATER_TEMPERATURE`. */
  readonly command: string;
  readonly rest: string;
}

function stripComment(raw: string): string {
  const semicolon = raw.indexOf(';');
  const body = semicolon === -1 ? raw : raw.slice(0, semicolon);
  return body.trim();
}

function parseLine(raw: string): ParsedLine | undefined {
  const body = stripComment(raw);
  if (body === '') return undefined;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/s.exec(body);
  if (match === null) return undefined;
  const [, head = '', rest = ''] = match;
  return { command: head.toUpperCase(), rest };
}

/** Read a single-letter word argument such as the `S` in `M104 S250`. */
function wordValue(rest: string, letter: string): number | undefined {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${letter}\\s*(-?\\d+(?:\\.\\d+)?)`, 'i');
  const match = pattern.exec(rest);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

/** Read a `KEY=VALUE` argument from a Klipper extended command. */
function keywordValue(rest: string, key: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\s)${key}\\s*=\\s*("[^"]*"|'[^']*'|\\S+)`, 'i');
  const match = pattern.exec(rest);
  if (match === null) return undefined;
  const raw = match[1];
  if (raw === undefined) return undefined;
  return raw.replace(/^["']|["']$/g, '');
}

/** Extract the slicer name from the header/footer comments most slicers emit. */
function sniffSlicer(raw: string): string | undefined {
  const generated = /;\s*generated by\s+([^,\n]+)/i.exec(raw);
  if (generated !== null) return generated[1]?.trim();
  const named = /;\s*(?:SLICER|Slicer)\s*[:=]\s*(.+)$/.exec(raw);
  if (named !== null) return named[1]?.trim();
  if (/^;\s*FLAVOR:/i.test(raw)) return 'Cura';
  return undefined;
}

function sniffEstimatedTime(raw: string): number | undefined {
  const cura = /;\s*TIME\s*[:=]\s*(\d+)/i.exec(raw);
  if (cura !== null) {
    const value = Number(cura[1]);
    return Number.isFinite(value) ? value : undefined;
  }
  const prusa = /;\s*estimated printing time[^=]*=\s*(.+)$/i.exec(raw);
  if (prusa !== null) {
    const text = prusa[1] ?? '';
    let seconds = 0;
    let matched = false;
    for (const [, amount, unit] of text.matchAll(/(\d+)\s*([dhms])/gi)) {
      const value = Number(amount);
      if (!Number.isFinite(value)) continue;
      matched = true;
      const factor = { d: 86_400, h: 3600, m: 60, s: 1 }[(unit ?? 's').toLowerCase()] ?? 1;
      seconds += value * factor;
    }
    return matched ? seconds : undefined;
  }
  return undefined;
}

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

interface MotionState {
  x: number;
  y: number;
  z: number;
  absolute: boolean;
  seen: boolean;
  seenX: boolean;
  seenY: boolean;
  seenZ: boolean;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** G92 rebases the coordinate system, so bounds become advisory. */
  rebased: boolean;
}

/**
 * Inspect a G-code program against a printer profile.
 *
 * Never throws for content reasons: the report carries the findings and
 * `ok` is false when any error-severity finding was raised. Use
 * {@link assertPreflightOk} to convert a failing report into a thrown error.
 */
export function preflightGcode(
  content: Uint8Array | string,
  options: PreflightOptions,
): PreflightReport {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const findings: PreflightFinding[] = [];
  const add = (finding: PreflightFinding): void => {
    findings.push(finding);
  };

  const maxScanLines = options.maxScanLines ?? DEFAULT_MAX_SCAN_LINES;
  const tolerance = options.boundsToleranceMm ?? DEFAULT_BOUNDS_TOLERANCE_MM;
  const profile = options.profile;
  const sha256 = options.sha256 ?? sha256Hex(bytes);

  if (bytes.length === 0) {
    add({ code: 'EMPTY_FILE', severity: 'error', message: 'The G-code file is empty.' });
  }
  if (bytes.length > options.maxBytes) {
    add({
      code: 'TOO_LARGE',
      severity: 'error',
      message: `File is ${bytes.length} bytes, above the ${options.maxBytes} byte limit.`,
      detail: { sizeBytes: bytes.length, maxBytes: options.maxBytes },
    });
  }
  const binary = looksBinary(bytes);
  if (binary) {
    add({
      code: 'BINARY_CONTENT',
      severity: 'error',
      message: 'File contains NUL bytes and is not plain-text G-code.',
    });
  }

  const motion: MotionState = {
    x: 0,
    y: 0,
    z: 0,
    absolute: true,
    seen: false,
    seenX: false,
    seenY: false,
    seenZ: false,
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY,
    rebased: false,
  };

  let maxExtruderTempC: number | undefined;
  let maxBedTempC: number | undefined;
  let maxChamberTempC: number | undefined;
  let slicer: string | undefined;
  let estimatedTimeSec: number | undefined;
  let homed = false;
  let extrudes = false;
  let lineCount = 0;
  let scannedLines = 0;
  let truncated = false;
  /** Danger findings are deduplicated by code so one bad macro cannot flood the report. */
  const seenDangers = new Set<string>();

  const noteTemp = (
    kind: 'extruder' | 'bed' | 'chamber',
    value: number,
    lineNumber: number,
  ): void => {
    if (!Number.isFinite(value)) return;
    if (kind === 'extruder') {
      maxExtruderTempC = Math.max(maxExtruderTempC ?? Number.NEGATIVE_INFINITY, value);
      if (value > profile.maxExtruderTempC) {
        add({
          code: 'EXTRUDER_TEMP_TOO_HIGH',
          severity: 'error',
          message: `Extruder target ${value}°C exceeds the ${profile.displayName} limit of ${profile.maxExtruderTempC}°C.`,
          line: lineNumber,
          detail: { requested: value, limit: profile.maxExtruderTempC },
        });
      }
      return;
    }
    if (kind === 'bed') {
      maxBedTempC = Math.max(maxBedTempC ?? Number.NEGATIVE_INFINITY, value);
      if (value > profile.maxBedTempC) {
        add({
          code: 'BED_TEMP_TOO_HIGH',
          severity: 'error',
          message: `Bed target ${value}°C exceeds the ${profile.displayName} limit of ${profile.maxBedTempC}°C.`,
          line: lineNumber,
          detail: { requested: value, limit: profile.maxBedTempC },
        });
      }
      return;
    }
    maxChamberTempC = Math.max(maxChamberTempC ?? Number.NEGATIVE_INFINITY, value);
    if (!profile.heatedChamber) {
      if (value > 0 && !seenDangers.has('CHAMBER_UNSUPPORTED')) {
        seenDangers.add('CHAMBER_UNSUPPORTED');
        add({
          code: 'CHAMBER_UNSUPPORTED',
          severity: 'warning',
          message: `${profile.displayName} has no heated chamber; the ${value}°C chamber target will be ignored.`,
          line: lineNumber,
          detail: { requested: value },
        });
      }
      return;
    }
    const limit = profile.maxChamberTempC;
    if (limit !== undefined && value > limit) {
      add({
        code: 'CHAMBER_TEMP_TOO_HIGH',
        severity: 'error',
        message: `Chamber target ${value}°C exceeds the ${profile.displayName} limit of ${limit}°C.`,
        line: lineNumber,
        detail: { requested: value, limit },
      });
    }
  };

  const noteDanger = (rule: DangerRule, command: string, lineNumber: number): void => {
    const key = `${rule.code}:${command}`;
    if (seenDangers.has(key)) return;
    seenDangers.add(key);
    add({
      code: rule.code,
      severity: rule.severity,
      message: `${command}: ${rule.message}`,
      line: lineNumber,
      detail: { command },
    });
  };

  const applyMove = (rest: string): void => {
    const x = wordValue(rest, 'X');
    const y = wordValue(rest, 'Y');
    const z = wordValue(rest, 'Z');
    const e = wordValue(rest, 'E');
    if (e !== undefined && e > 0) extrudes = true;
    if (x === undefined && y === undefined && z === undefined) return;

    if (motion.absolute) {
      if (x !== undefined) motion.x = x;
      if (y !== undefined) motion.y = y;
      if (z !== undefined) motion.z = z;
    } else {
      if (x !== undefined) motion.x += x;
      if (y !== undefined) motion.y += y;
      if (z !== undefined) motion.z += z;
    }
    if (x !== undefined) motion.seenX = true;
    if (y !== undefined) motion.seenY = true;
    if (z !== undefined) motion.seenZ = true;
    motion.seen = true;
    if (motion.seenX) {
      motion.minX = Math.min(motion.minX, motion.x);
      motion.maxX = Math.max(motion.maxX, motion.x);
    }
    if (motion.seenY) {
      motion.minY = Math.min(motion.minY, motion.y);
      motion.maxY = Math.max(motion.maxY, motion.y);
    }
    if (motion.seenZ) {
      motion.minZ = Math.min(motion.minZ, motion.z);
      motion.maxZ = Math.max(motion.maxZ, motion.z);
    }
  };

  const handleLine = (raw: string, lineNumber: number): void => {
    if (slicer === undefined) {
      const found = sniffSlicer(raw);
      if (found !== undefined && found !== '') slicer = found;
    }
    if (estimatedTimeSec === undefined) {
      const found = sniffEstimatedTime(raw);
      if (found !== undefined) estimatedTimeSec = found;
    }

    const parsed = parseLine(raw);
    if (parsed === undefined) return;
    const { command, rest } = parsed;

    const classic = /^([GM])(\d+)$/.exec(command);
    if (classic !== null) {
      const letter = classic[1];
      const code = Number(classic[2]);
      if (letter === 'G') {
        switch (code) {
          case 0:
          case 1:
          case 2:
          case 3:
            applyMove(rest);
            return;
          case 28:
            homed = true;
            motion.x = 0;
            motion.y = 0;
            motion.z = 0;
            return;
          case 90:
            motion.absolute = true;
            return;
          case 91:
            motion.absolute = false;
            return;
          case 92: {
            const x = wordValue(rest, 'X');
            const y = wordValue(rest, 'Y');
            const z = wordValue(rest, 'Z');
            if (x !== undefined || y !== undefined || z !== undefined) motion.rebased = true;
            if (x !== undefined) motion.x = x;
            if (y !== undefined) motion.y = y;
            if (z !== undefined) motion.z = z;
            return;
          }
          default:
            return;
        }
      }

      const danger = MCODE_DANGERS[code];
      if (danger !== undefined) noteDanger(danger, command, lineNumber);

      switch (code) {
        case 104:
        case 109: {
          const target = wordValue(rest, 'S') ?? wordValue(rest, 'R');
          if (target !== undefined) noteTemp('extruder', target, lineNumber);
          return;
        }
        case 140:
        case 190: {
          const target = wordValue(rest, 'S') ?? wordValue(rest, 'R');
          if (target !== undefined) noteTemp('bed', target, lineNumber);
          return;
        }
        case 141:
        case 191: {
          const target = wordValue(rest, 'S') ?? wordValue(rest, 'R');
          if (target !== undefined) noteTemp('chamber', target, lineNumber);
          return;
        }
        case 303: {
          const target = wordValue(rest, 'S');
          const heaterIndex = wordValue(rest, 'E');
          if (target !== undefined) {
            noteTemp(heaterIndex === -1 ? 'bed' : 'extruder', target, lineNumber);
          }
          return;
        }
        default:
          return;
      }
    }

    const extendedDanger = EXTENDED_DANGERS[command];
    if (extendedDanger !== undefined) noteDanger(extendedDanger, command, lineNumber);

    if (command === 'SET_HEATER_TEMPERATURE') {
      const heater = (keywordValue(rest, 'HEATER') ?? '').toLowerCase();
      const target = Number(keywordValue(rest, 'TARGET') ?? '');
      if (!Number.isFinite(target)) return;
      if (heater.includes('bed')) noteTemp('bed', target, lineNumber);
      else if (heater.includes('chamber')) noteTemp('chamber', target, lineNumber);
      else noteTemp('extruder', target, lineNumber);
      return;
    }
    if (command === 'TEMPERATURE_WAIT') {
      const sensor = (keywordValue(rest, 'SENSOR') ?? '').toLowerCase();
      const maximum = Number(keywordValue(rest, 'MAXIMUM') ?? '');
      if (!Number.isFinite(maximum)) return;
      if (sensor.includes('bed')) noteTemp('bed', maximum, lineNumber);
      else if (sensor.includes('chamber')) noteTemp('chamber', maximum, lineNumber);
      else if (sensor.includes('extruder')) noteTemp('extruder', maximum, lineNumber);
      return;
    }
    if (command === 'G28' || command === 'HOME') {
      homed = true;
    }
  };

  // --- streaming scan -------------------------------------------------------
  if (!binary && bytes.length > 0) {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let carry = '';
    let stopped = false;

    const flushChunk = (text: string, last: boolean): void => {
      if (stopped) return;
      carry += text;
      let start = 0;
      for (;;) {
        const newline = carry.indexOf('\n', start);
        if (newline === -1) break;
        let end = newline;
        if (end > start && carry.charCodeAt(end - 1) === 13) end -= 1;
        lineCount += 1;
        if (scannedLines < maxScanLines) {
          scannedLines += 1;
          handleLine(carry.slice(start, end), lineCount);
        } else {
          truncated = true;
          stopped = true;
          carry = '';
          return;
        }
        start = newline + 1;
      }
      carry = carry.slice(start);
      if (last && carry !== '') {
        const end = carry.endsWith('\r') ? carry.length - 1 : carry.length;
        lineCount += 1;
        if (scannedLines < maxScanLines) {
          scannedLines += 1;
          handleLine(carry.slice(0, end), lineCount);
        } else {
          truncated = true;
        }
        carry = '';
      }
    };

    for (let offset = 0; offset < bytes.length && !stopped; offset += CHUNK_BYTES) {
      const end = Math.min(offset + CHUNK_BYTES, bytes.length);
      flushChunk(decoder.decode(bytes.subarray(offset, end), { stream: true }), false);
    }
    if (!stopped) flushChunk(decoder.decode(), true);
  }

  if (truncated) {
    add({
      code: 'SCAN_TRUNCATED',
      severity: 'warning',
      message: `Only the first ${scannedLines} lines were inspected; the remainder was not checked.`,
      detail: { scannedLines, maxScanLines },
    });
  }

  // --- whole-program findings ----------------------------------------------
  const volume = profile.buildVolumeMm;
  let bounds: PreflightBounds | undefined;
  if (motion.seen) {
    bounds = {
      minX: round(motion.minX),
      maxX: round(motion.maxX),
      minY: round(motion.minY),
      maxY: round(motion.maxY),
      minZ: round(motion.minZ),
      maxZ: round(motion.maxZ),
    };

    // A G92 rebase means our coordinates may not be the machine's, so a
    // violation is reported but not treated as disqualifying.
    const severity: PreflightSeverity = motion.rebased ? 'warning' : 'error';
    const violations: string[] = [];
    if (bounds.maxX > volume.x + tolerance) violations.push(`X max ${bounds.maxX} > ${volume.x}`);
    if (bounds.maxY > volume.y + tolerance) violations.push(`Y max ${bounds.maxY} > ${volume.y}`);
    if (bounds.maxZ > volume.z + tolerance) violations.push(`Z max ${bounds.maxZ} > ${volume.z}`);
    if (bounds.minX < -tolerance) violations.push(`X min ${bounds.minX} < 0`);
    if (bounds.minY < -tolerance) violations.push(`Y min ${bounds.minY} < 0`);
    if (violations.length > 0) {
      add({
        code: 'OUT_OF_BOUNDS',
        severity,
        message:
          `Toolhead motion leaves the ${profile.displayName} build volume ` +
          `(${volume.x}×${volume.y}×${volume.z} mm): ${violations.join('; ')}.` +
          (motion.rebased ? ' Reported as a warning because the file uses G92 offsets.' : ''),
        detail: { bounds, buildVolumeMm: volume, toleranceMm: tolerance, violations },
      });
    }
    if (bounds.minZ < -tolerance) {
      add({
        code: 'NEGATIVE_Z',
        severity: 'warning',
        message: `Program commands Z down to ${bounds.minZ} mm, below the bed.`,
        detail: { minZ: bounds.minZ },
      });
    }
    if (!homed) {
      add({
        code: 'NO_HOMING',
        severity: 'warning',
        message: 'Program moves the toolhead without a G28 home first.',
      });
    }
  }

  if (!extrudes && bytes.length > 0 && !binary) {
    add({
      code: 'NO_EXTRUSION',
      severity: 'warning',
      message: 'Program contains no positive extrusion moves; it will not print anything.',
    });
  }

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  const ok = errors.length === 0;

  return {
    ok,
    filename: options.filename,
    sizeBytes: bytes.length,
    sha256,
    lineCount,
    scannedLines,
    truncated,
    errors,
    warnings,
    ...(maxExtruderTempC === undefined ? {} : { maxExtruderTempC }),
    ...(maxBedTempC === undefined ? {} : { maxBedTempC }),
    ...(maxChamberTempC === undefined ? {} : { maxChamberTempC }),
    ...(bounds === undefined ? {} : { bounds }),
    homed,
    extrudes,
    ...(slicer === undefined ? {} : { slicer }),
    ...(estimatedTimeSec === undefined ? {} : { estimatedTimeSec }),
    summary: summarize({
      ok,
      filename: options.filename,
      sizeBytes: bytes.length,
      errors,
      warnings,
      maxExtruderTempC,
      maxBedTempC,
    }),
  };
}

/** Throw `PREFLIGHT_FAILED` when a report carries error-severity findings. */
export function assertPreflightOk(report: PreflightReport): void {
  if (report.ok) return;
  const reasons = report.errors.map((finding) => finding.message).join(' ');
  throw new CrealityError(
    'PREFLIGHT_FAILED',
    `G-code preflight rejected "${report.filename}": ${reasons}`,
    {
      details: {
        filename: report.filename,
        errors: report.errors,
        warnings: report.warnings,
      },
    },
  );
}

function round(value: number, decimals = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function summarize(input: {
  readonly ok: boolean;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly errors: readonly PreflightFinding[];
  readonly warnings: readonly PreflightFinding[];
  readonly maxExtruderTempC: number | undefined;
  readonly maxBedTempC: number | undefined;
}): string {
  const parts = [
    `${input.filename} (${formatBytes(input.sizeBytes)})`,
    input.ok ? 'passed preflight' : `failed preflight with ${input.errors.length} error(s)`,
  ];
  if (input.warnings.length > 0) parts.push(`${input.warnings.length} warning(s)`);
  const temps: string[] = [];
  if (input.maxExtruderTempC !== undefined) temps.push(`nozzle ${input.maxExtruderTempC}°C`);
  if (input.maxBedTempC !== undefined) temps.push(`bed ${input.maxBedTempC}°C`);
  if (temps.length > 0) parts.push(temps.join(', '));
  return parts.join('; ');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Static per-model safety envelopes.
 *
 * These are conservative published-spec limits used to reject obviously unsafe
 * G-code before it ever reaches the printer. They are a guard rail, not a
 * substitute for the firmware's own limits: the printer remains the final
 * authority and may refuse things this profile allows.
 */

import { CrealityError } from './errors.js';
import type { MutatingAction, PrinterModel } from './types.js';

export interface PrinterProfile {
  readonly model: PrinterModel;
  readonly displayName: string;
  readonly buildVolumeMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly maxExtruderTempC: number;
  readonly maxBedTempC: number;
  readonly maxChamberTempC?: number;
  readonly heatedChamber: boolean;
  /** Upper bound on an uploadable G-code file for this class of machine. */
  readonly maxGcodeBytes: number;
  readonly supportedActions: readonly MutatingAction[];
  readonly compatibilityNotes: readonly string[];
}

const ALL_ACTIONS: readonly MutatingAction[] = [
  'upload_gcode',
  'start_print',
  'pause_print',
  'resume_print',
  'cancel_print',
];

const MB = 1024 * 1024;

export const PRINTER_PROFILES: Readonly<Record<PrinterModel, PrinterProfile>> = {
  k1: {
    model: 'k1',
    displayName: 'Creality K1',
    buildVolumeMm: { x: 220, y: 220, z: 250 },
    maxExtruderTempC: 300,
    maxBedTempC: 100,
    heatedChamber: false,
    maxGcodeBytes: 256 * MB,
    supportedActions: ALL_ACTIONS,
    compatibilityNotes: [],
  },
  k1c: {
    model: 'k1c',
    displayName: 'Creality K1C',
    buildVolumeMm: { x: 220, y: 220, z: 250 },
    maxExtruderTempC: 300,
    maxBedTempC: 100,
    heatedChamber: false,
    maxGcodeBytes: 256 * MB,
    supportedActions: ALL_ACTIONS,
    compatibilityNotes: [],
  },
  'k1-max': {
    model: 'k1-max',
    displayName: 'Creality K1 Max',
    buildVolumeMm: { x: 300, y: 300, z: 300 },
    maxExtruderTempC: 300,
    maxBedTempC: 100,
    heatedChamber: false,
    maxGcodeBytes: 512 * MB,
    supportedActions: ALL_ACTIONS,
    compatibilityNotes: [],
  },
  k2: {
    model: 'k2',
    displayName: 'Creality K2 Plus',
    buildVolumeMm: { x: 350, y: 350, z: 350 },
    maxExtruderTempC: 350,
    maxBedTempC: 120,
    maxChamberTempC: 60,
    heatedChamber: true,
    maxGcodeBytes: 512 * MB,
    supportedActions: ALL_ACTIONS,
    compatibilityNotes: [],
  },
  'hi-combo': {
    model: 'hi-combo',
    displayName: 'Creality Hi Combo',
    buildVolumeMm: { x: 260, y: 260, z: 300 },
    maxExtruderTempC: 300,
    maxBedTempC: 100,
    heatedChamber: false,
    maxGcodeBytes: 256 * MB,
    supportedActions: ALL_ACTIONS,
    compatibilityNotes: [
      'Requires a Moonraker-compatible local endpoint; stock firmware may not expose one.',
      'CFS multicolor/material mapping and direct 3MF printing are not supported by this MVP.',
      'Use single-color G-code generated for the Creality Hi profile and validate with dry-run first.',
    ],
  },
};

export const SUPPORTED_MODELS = Object.keys(PRINTER_PROFILES) as readonly PrinterModel[];

/** Accepts loose spellings such as `K1 Max`, `k1_max`, `K2 Plus`. */
export function normalizeModel(raw: string): PrinterModel {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const aliases: Record<string, PrinterModel> = {
    k1: 'k1',
    k1c: 'k1c',
    'k1-c': 'k1c',
    'k1-max': 'k1-max',
    k1max: 'k1-max',
    k2: 'k2',
    'k2-plus': 'k2',
    k2plus: 'k2',
    hi: 'hi-combo',
    'creality-hi': 'hi-combo',
    'hi-combo': 'hi-combo',
    hicombo: 'hi-combo',
    'creality-hi-combo': 'hi-combo',
  };
  const model = aliases[key];
  if (model === undefined) {
    throw new CrealityError(
      'CONFIG_INVALID',
      `Unknown printer model "${raw}". Supported: ${SUPPORTED_MODELS.join(', ')}.`,
      { details: { supported: SUPPORTED_MODELS } },
    );
  }
  return model;
}

export function getProfile(model: PrinterModel): PrinterProfile {
  const profile = PRINTER_PROFILES[model];
  /* c8 ignore next */
  if (profile === undefined) throw new CrealityError('CONFIG_INVALID', `No profile for ${model}`);
  return profile;
}

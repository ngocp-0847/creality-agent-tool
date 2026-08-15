/**
 * Shared test fixtures.
 *
 * The service tests drive the *real* stack — HttpClient, SSRF validation,
 * MoonrakerClient, the service gate — and fake only `fetch`. That way the
 * safety rails under test are the ones that ship.
 */

import { defineConfig, type ConfigInput, type CrealityConfig } from '../src/config.js';
import { CrealityService, type CrealityServiceDeps } from '../src/service.js';

/** A private-range literal, so SSRF validation passes without a resolver. */
export const TEST_BASE_URL = 'http://192.168.1.42:7125';

export interface PrinterFixtureState {
  /** Klipper `print_stats.state`: standby | printing | paused | complete | error. */
  jobState: string;
  filename: string | undefined;
  progress: number;
  klippyConnected: boolean;
  klippyState: string;
  /** Files reported by `/server/files/list`. */
  files: { path: string; size: number; modified: number }[];
  /** Filenames `/server/files/metadata` will resolve; others 404. */
  knownMetadata: Set<string>;
}

export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface PrinterFixture {
  readonly state: PrinterFixtureState;
  readonly calls: FetchCall[];
  readonly fetch: typeof globalThis.fetch;
  /** Paths hit, in order, e.g. `/printer/print/pause`. */
  paths(): string[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function defaultState(): PrinterFixtureState {
  return {
    jobState: 'standby',
    filename: undefined,
    progress: 0,
    klippyConnected: true,
    klippyState: 'ready',
    files: [
      { path: 'benchy.gcode', size: 2048, modified: 1_700_000_000 },
      { path: 'calibration/cube.gcode', size: 1024, modified: 1_600_000_000 },
    ],
    knownMetadata: new Set(['benchy.gcode', 'calibration/cube.gcode']),
  };
}

/** A fake Moonraker that answers the endpoints this tool actually uses. */
export function createPrinterFixture(
  overrides: Partial<PrinterFixtureState> = {},
): PrinterFixture {
  const state: PrinterFixtureState = { ...defaultState(), ...overrides };
  const calls: FetchCall[] = [];

  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : String(input);
    const url = new URL(raw);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url: raw, method: init?.method ?? 'GET', headers });

    switch (url.pathname) {
      case '/printer/info':
        return json({
          result: {
            state: state.klippyState,
            state_message: `Printer is ${state.klippyState}`,
            software_version: 'v0.12.0',
            hostname: 'k1',
          },
        });

      case '/server/info':
        return json({
          result: {
            klippy_connected: state.klippyConnected,
            klippy_state: state.klippyState,
            moonraker_version: 'v0.9.1',
            components: ['file_manager', 'klippy_apis'],
          },
        });

      case '/printer/objects/query':
        return json({
          result: {
            eventtime: 1234.5,
            status: {
              extruder: { temperature: 24.5, target: 0, power: 0 },
              heater_bed: { temperature: 23.1, target: 0, power: 0 },
              print_stats: {
                state: state.jobState,
                ...(state.filename === undefined ? {} : { filename: state.filename }),
                print_duration: 600,
                total_duration: 650,
                filament_used: 1234.5,
              },
              virtual_sdcard: { progress: state.progress, is_active: state.jobState === 'printing' },
              display_status: { progress: state.progress },
              toolhead: { position: [1, 2, 3, 0], homed_axes: 'xyz' },
              fan: { speed: 0.5 },
            },
          },
        });

      case '/server/files/list':
        return json({ result: state.files });

      case '/server/files/metadata': {
        const filename = url.searchParams.get('filename') ?? '';
        if (!state.knownMetadata.has(filename)) {
          return json({ error: { message: `File ${filename} not found` } }, 404);
        }
        return json({
          result: {
            filename,
            size: 2048,
            modified: 1_700_000_000,
            estimated_time: 3600,
            filament_total: 2500.5,
            first_layer_bed_temp: 60,
            first_layer_extr_temp: 210,
            object_height: 48.2,
            slicer: 'PrusaSlicer',
          },
        });
      }

      case '/server/files/upload': {
        const started = state.jobState === 'printing';
        return json({
          result: {
            item: { path: 'uploaded.gcode', root: 'gcodes' },
            print_started: started,
            action: 'create_file',
          },
        });
      }

      case '/printer/print/start':
        state.jobState = 'printing';
        state.filename = url.searchParams.get('filename') ?? undefined;
        return json({ result: 'ok' });

      case '/printer/print/pause':
        state.jobState = 'paused';
        return json({ result: 'ok' });

      case '/printer/print/resume':
        state.jobState = 'printing';
        return json({ result: 'ok' });

      case '/printer/print/cancel':
        state.jobState = 'cancelled';
        return json({ result: 'ok' });

      default:
        return json({ error: { message: `Unhandled path ${url.pathname}` } }, 404);
    }
  }) as unknown as typeof globalThis.fetch;

  return {
    state,
    calls,
    fetch: fetchImpl,
    paths: () => calls.map((call) => new URL(call.url).pathname),
  };
}

export function testConfig(overrides: Partial<ConfigInput> = {}): CrealityConfig {
  return defineConfig({
    baseUrl: TEST_BASE_URL,
    model: 'k1',
    confirmationTtlMs: 60_000,
    maxUploadBytes: 1024 * 1024,
    dryRunDefault: false,
    ...overrides,
  });
}

export interface TestServiceHandle {
  readonly service: CrealityService;
  readonly fixture: PrinterFixture;
}

export function createTestService(options: {
  readonly config?: Partial<ConfigInput>;
  readonly state?: Partial<PrinterFixtureState>;
  readonly deps?: Omit<CrealityServiceDeps, 'fetch'>;
} = {}): TestServiceHandle {
  const fixture = createPrinterFixture(options.state ?? {});
  const service = new CrealityService(testConfig(options.config ?? {}), {
    fetch: fixture.fetch,
    ...(options.deps ?? {}),
  });
  return { service, fixture };
}

/** A small, clean, in-bounds program that passes preflight with no findings. */
export const GOOD_GCODE = [
  '; generated by PrusaSlicer 2.6.0',
  ';TIME:3600',
  'G28',
  'G90',
  'M140 S60',
  'M104 S210',
  'M190 S60',
  'M109 S210',
  'G1 Z0.2 F1200',
  'G1 X10 Y10 E1 F1800',
  'G1 X100 Y100 E5',
  'G1 X100 Y10 E9',
  'M104 S0',
  'M140 S0',
  '',
].join('\n');

/** Captures audit lines without touching the filesystem. */
export function createAuditSink(): {
  readonly lines: string[];
  readonly write: (line: string) => Promise<void>;
} {
  const lines: string[] = [];
  return {
    lines,
    write: async (line: string): Promise<void> => {
      lines.push(line);
      await Promise.resolve();
    },
  };
}

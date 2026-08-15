/**
 * Fixtures for the CAD workspace tests.
 *
 * OpenSCAD is never invoked. {@link FakeOpenScadRunner} stands in for it and
 * writes plausible bytes to whatever `-o` path it is given, so the store's
 * atomic publish path is exercised for real while the tests stay fast and
 * runnable on a machine with no OpenSCAD installed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineModelConfig, type ModelConfig } from '../src/model/config.js';
import type {
  OpenScadRunOptions,
  OpenScadRunResult,
  OpenScadRunner,
  OpenScadStatus,
} from '../src/model/openscad.js';
import { ModelService } from '../src/model/service.js';

export interface FakeRunOptions {
  /** Replace the default success behaviour, e.g. to simulate a compile error. */
  readonly behaviour?: (options: OpenScadRunOptions) => Partial<OpenScadRunResult>;
  readonly status?: OpenScadStatus;
}

export class FakeOpenScadRunner implements OpenScadRunner {
  readonly calls: OpenScadRunOptions[] = [];
  #status: OpenScadStatus;
  #behaviour: ((options: OpenScadRunOptions) => Partial<OpenScadRunResult>) | undefined;

  constructor(options: FakeRunOptions = {}) {
    this.#status = options.status ?? {
      available: true,
      path: '/usr/bin/openscad',
      version: '2021.01',
    };
    this.#behaviour = options.behaviour;
  }

  setStatus(status: OpenScadStatus): void {
    this.#status = status;
  }

  setBehaviour(behaviour: (options: OpenScadRunOptions) => Partial<OpenScadRunResult>): void {
    this.#behaviour = behaviour;
  }

  async status(): Promise<OpenScadStatus> {
    return this.#status;
  }

  /** The `-o` argument, as OpenSCAD itself would read it. */
  static outputPath(options: OpenScadRunOptions): string {
    const index = options.args.indexOf('-o');
    return options.args[index + 1] ?? '';
  }

  async run(options: OpenScadRunOptions): Promise<OpenScadRunResult> {
    this.calls.push(options);
    const override = this.#behaviour?.(options) ?? {};
    const base: OpenScadRunResult = {
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      truncated: false,
      ...override,
    };

    if (base.ok) {
      // Real OpenSCAD leaves a file behind; the store then renames it.
      await writeFile(FakeOpenScadRunner.outputPath(options), Buffer.from('fake-artifact-bytes'));
    }
    return base;
  }
}

export interface ModelFixture {
  readonly dir: string;
  readonly config: ModelConfig;
  readonly service: ModelService;
  readonly runner: FakeOpenScadRunner;
  cleanup(): Promise<void>;
}

export async function createModelFixture(
  options: { readonly runner?: FakeOpenScadRunner; readonly config?: Partial<ModelConfig> } = {},
): Promise<ModelFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'creality-model-'));
  const runner = options.runner ?? new FakeOpenScadRunner();
  const config = defineModelConfig({ workspaceDir: dir, ...(options.config ?? {}) });
  const service = new ModelService(config, { runner });

  return {
    dir,
    config,
    service,
    runner,
    cleanup: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A small, valid, parametric part — the shape an agent is asked to emit. */
export const SAMPLE_SCAD = [
  '// Cable clip, 6mm cable',
  'cable_d = 6;',
  'wall = 2;',
  'width = 10;',
  '',
  'difference() {',
  '  cylinder(h = width, d = cable_d + wall * 2, $fn = 64);',
  '  translate([0, 0, -1])',
  '    cylinder(h = width + 2, d = cable_d, $fn = 64);',
  '  translate([-cable_d / 2, 0, -1])',
  '    cube([cable_d, cable_d, width + 2]);',
  '}',
].join('\n');

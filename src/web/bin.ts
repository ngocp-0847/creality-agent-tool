#!/usr/bin/env node
/**
 * Entry point for the local model editor (`npm run model:web`).
 *
 * Configuration comes from the same `.env` fields as the MCP server, but the
 * editor needs no printer: it starts, and works, with no `CREALITY_PRINTER_URL`
 * set at all.
 */

import { pathToFileURL } from 'node:url';

import { CrealityError } from '../errors.js';
import { loadModelConfigFromEnv } from '../model/config.js';
import { ModelService } from '../model/service.js';
import { startModelWebServer, type RunningModelWebServer } from './server.js';

const LABEL = 'creality-model-web';

function note(message: string): void {
  process.stderr.write(`[${LABEL}] ${message}\n`);
}

export async function main(): Promise<void> {
  let running: RunningModelWebServer;
  let service: ModelService;

  try {
    const config = loadModelConfigFromEnv();
    service = new ModelService(config);
    running = await startModelWebServer({
      service,
      host: config.webHost,
      port: config.webPort,
    });
    note(`editing ${config.workspaceDir}`);
    note(`listening on ${running.url} (localhost only)`);
  } catch (error) {
    const wrapped = CrealityError.wrap(error, 'CONFIG_INVALID');
    note(`startup failed (${wrapped.code}): ${wrapped.message}`);
    process.exitCode = 1;
    return;
  }

  // Report the toolchain once at startup: "render did nothing" is a confusing
  // way to discover OpenSCAD is not installed.
  const toolchain = await service.toolchain();
  note(
    toolchain.available
      ? `openscad ${toolchain.version ?? 'detected'} at ${toolchain.path ?? 'unknown path'}`
      : `openscad unavailable — ${toolchain.reason ?? 'not found'}`,
  );

  const shutdown = (signal: string): void => {
    note(`received ${signal}, shutting down`);
    void running.close().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
}

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    const wrapped = CrealityError.wrap(error);
    note(`fatal: ${wrapped.message}`);
    process.exit(1);
  });
}

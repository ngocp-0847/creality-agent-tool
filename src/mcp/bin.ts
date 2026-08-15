#!/usr/bin/env node
/**
 * stdio entry point for the MCP server.
 *
 * stdout carries the protocol and nothing else — every diagnostic goes to
 * stderr. A misconfiguration is reported and exits non-zero rather than
 * starting a server that would fail on first use.
 */

import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfigFromEnv } from '../config.js';
import { CrealityError } from '../errors.js';
import { loadModelConfigFromEnv } from '../model/config.js';
import { ModelService } from '../model/service.js';
import { CrealityService } from '../service.js';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

function note(message: string): void {
  process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
}

export async function main(): Promise<void> {
  let service: CrealityService;
  let models: ModelService;
  try {
    const config = loadConfigFromEnv();
    service = new CrealityService(config);
    const modelConfig = loadModelConfigFromEnv();
    models = new ModelService(modelConfig);
    note(
      `v${SERVER_VERSION} ready — model=${config.model} target=${config.baseUrl} ` +
        `dryRunDefault=${String(config.dryRunDefault)} confirmationTtl=${config.confirmationTtlMs}ms`,
    );
    note(`cad workspace=${modelConfig.workspaceDir}`);
  } catch (error) {
    const wrapped = CrealityError.wrap(error, 'CONFIG_INVALID');
    note(`startup failed (${wrapped.code}): ${wrapped.message}`);
    process.exitCode = 1;
    return;
  }

  const server = createMcpServer(service, models);
  const transport = new StdioServerTransport();

  const shutdown = (signal: string): void => {
    note(`received ${signal}, shutting down`);
    void server.close().finally(() => {
      process.exit(0);
    });
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  await server.connect(transport);
}

// Only self-start when executed directly, so tests can import `main`.
const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly || process.env['CREALITY_MCP_AUTOSTART'] === '1') {
  main().catch((error: unknown) => {
    const wrapped = CrealityError.wrap(error);
    note(`fatal: ${wrapped.message}`);
    process.exit(1);
  });
}

/**
 * MCP facade.
 *
 * A thin, deliberately dumb shell over {@link CrealityService}. It translates
 * JSON arguments into service calls and service results into MCP content. It
 * holds no policy of its own: if a rule is not enforced in the service, it is
 * not enforced.
 *
 * Two conventions matter to the agent on the other end:
 *   - Mutating tools take `dry_run` and `confirmation_token`. Call once with
 *     `dry_run: true` to get a plan plus a token, show the plan to a human, then
 *     call again with the token.
 *   - Failures come back as `isError` results carrying the structured
 *     `CrealityError` (stable `code`, `retryable`), not as prose.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { CrealityError } from '../errors.js';
import type { CrealityService, MutationOptions } from '../service.js';

export const SERVER_NAME = 'creality-agent-tool';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Control a Creality K1-class 3D printer over Klipper/Moonraker.

This server can move a physical machine. Mutating tools (upload, start, pause,
resume, cancel) follow a two-phase protocol:

  1. Call the tool with dry_run=true. You get a plan, a preflight report where
     relevant, and a single-use confirmation_token.
  2. Show the plan to the operator. If they approve, call the same tool again
     with identical arguments plus confirmation_token.

Tokens are bound to the exact arguments and expire in minutes. Changing any
argument invalidates the token. Never fabricate a token, and never present a
dry-run result as though the action happened.

Arbitrary G-code execution, emergency stop, firmware updates, config edits and
file deletion are not exposed; printer_capabilities lists them with reasons.`;

const mutationShape = {
  dry_run: z
    .boolean()
    .optional()
    .describe('Plan without acting. Returns a confirmation_token to replay with.'),
  confirmation_token: z
    .string()
    .optional()
    .describe('Single-use token from a prior dry run of this exact call.'),
};

function mutationOptions(args: {
  readonly dry_run?: boolean | undefined;
  readonly confirmation_token?: string | undefined;
}): MutationOptions {
  return {
    ...(args.dry_run === undefined ? {} : { dryRun: args.dry_run }),
    ...(args.confirmation_token === undefined
      ? {}
      : { confirmationToken: args.confirmation_token }),
  };
}

function ok(value: unknown): CallToolResult {
  const structured =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
  };
}

function fail(error: unknown): CallToolResult {
  const crealityError = CrealityError.wrap(error);
  const payload = crealityError.toJSON();
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

async function guard(run: () => unknown): Promise<CallToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}

/** Build an MCP server exposing `service`. The caller owns the transport. */
export function createMcpServer(service: CrealityService): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

  // --- observation ----------------------------------------------------------

  server.registerTool(
    'printer_status',
    {
      title: 'Printer status',
      description:
        'Current printer and job state: temperatures, position, progress, and the raw Klipper state string.',
      inputSchema: {},
      annotations: { ...readOnly, title: 'Printer status' },
    },
    async () => await guard(() => service.status()),
  );

  server.registerTool(
    'printer_job',
    {
      title: 'Current job',
      description: 'Just the active job: filename, progress, durations, estimated time remaining.',
      inputSchema: {},
      annotations: { ...readOnly, title: 'Current job' },
    },
    async () => await guard(() => service.job()),
  );

  server.registerTool(
    'printer_capabilities',
    {
      title: 'Printer capabilities',
      description:
        'Build volume, temperature limits, upload ceiling, supported actions, and the actions this tool refuses to expose (with reasons). Reads from the printer only when live=true.',
      inputSchema: {
        live: z
          .boolean()
          .optional()
          .describe('Also query the printer for its enabled Moonraker components.'),
      },
      annotations: { ...readOnly, title: 'Printer capabilities' },
    },
    async ({ live }) =>
      await guard(() => (live === true ? service.capabilitiesLive() : service.capabilities())),
  );

  server.registerTool(
    'gcode_list',
    {
      title: 'List G-code files',
      description: 'List G-code files stored on the printer, newest first.',
      inputSchema: {
        search: z.string().optional().describe('Case-insensitive substring filter on the path.'),
        limit: z.number().int().positive().max(500).optional().describe('Default 100, max 500.'),
      },
      annotations: { ...readOnly, title: 'List G-code files' },
    },
    async ({ search, limit }) =>
      await guard(async () => ({
        files: await service.listFiles({
          ...(search === undefined ? {} : { search }),
          ...(limit === undefined ? {} : { limit }),
        }),
      })),
  );

  server.registerTool(
    'gcode_metadata',
    {
      title: 'G-code metadata',
      description:
        'Slicer metadata for one file already on the printer: estimated time, filament use, first-layer temps, object height.',
      inputSchema: {
        filename: z.string().describe('Printer-relative path, e.g. "benchy.gcode".'),
      },
      annotations: { ...readOnly, title: 'G-code metadata' },
    },
    async ({ filename }) => await guard(() => service.fileMetadata(filename)),
  );

  server.registerTool(
    'gcode_preflight',
    {
      title: 'Preflight G-code',
      description:
        'Statically inspect a G-code program against this printer model without uploading it. Reports temperature and build-volume violations, firmware-mutating commands, and content warnings. Offline and side-effect free.',
      inputSchema: {
        filename: z.string().describe('Name the file would have on the printer.'),
        content: z.string().describe('The G-code program.'),
        encoding: z
          .enum(['utf8', 'base64'])
          .optional()
          .describe('How `content` is encoded. Default utf8.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ filename, content, encoding }) =>
      await guard(() =>
        service.preflight({
          filename,
          content,
          ...(encoding === undefined ? {} : { encoding }),
        }),
      ),
  );

  server.registerTool(
    'audit_tail',
    {
      title: 'Audit trail',
      description:
        'Recent mutating-action records from this session, including refused attempts and the reason each was refused.',
      inputSchema: {
        limit: z.number().int().positive().max(500).optional().describe('Default 50.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ limit }) =>
      await guard(() => ({ records: service.auditTail(limit ?? 50) })),
  );

  // --- mutation -------------------------------------------------------------

  server.registerTool(
    'gcode_upload',
    {
      title: 'Upload G-code',
      description:
        'Upload a G-code program to the printer, optionally starting it. Runs preflight first and refuses on any error-severity finding. Requires confirmation.',
      inputSchema: {
        filename: z.string().describe('Printer-relative destination path.'),
        content: z.string().describe('The G-code program.'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('Default utf8.'),
        start_print: z
          .boolean()
          .optional()
          .describe('Begin printing immediately after upload. Default false.'),
        ...mutationShape,
      },
      annotations: {
        title: 'Upload G-code',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ filename, content, encoding, start_print, dry_run, confirmation_token }) =>
      await guard(() =>
        service.uploadGcode({
          filename,
          content,
          ...(encoding === undefined ? {} : { encoding }),
          ...(start_print === undefined ? {} : { startPrint: start_print }),
          ...mutationOptions({ dry_run, confirmation_token }),
        }),
      ),
  );

  server.registerTool(
    'print_start',
    {
      title: 'Start print',
      description:
        'Start printing a file already on the printer. Fails if a job is already active. Requires confirmation.',
      inputSchema: {
        filename: z.string().describe('Printer-relative path of an existing file.'),
        ...mutationShape,
      },
      annotations: {
        title: 'Start print',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ filename, dry_run, confirmation_token }) =>
      await guard(() =>
        service.startPrint({ filename, ...mutationOptions({ dry_run, confirmation_token }) }),
      ),
  );

  server.registerTool(
    'print_pause',
    {
      title: 'Pause print',
      description: 'Pause the running print. Requires confirmation.',
      inputSchema: { ...mutationShape },
      annotations: {
        title: 'Pause print',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dry_run, confirmation_token }) =>
      await guard(() => service.pausePrint(mutationOptions({ dry_run, confirmation_token }))),
  );

  server.registerTool(
    'print_resume',
    {
      title: 'Resume print',
      description: 'Resume a paused print. Requires confirmation.',
      inputSchema: { ...mutationShape },
      annotations: {
        title: 'Resume print',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dry_run, confirmation_token }) =>
      await guard(() => service.resumePrint(mutationOptions({ dry_run, confirmation_token }))),
  );

  server.registerTool(
    'print_cancel',
    {
      title: 'Cancel print',
      description:
        'Cancel the current print. The partially printed object is scrapped and cannot be resumed. Requires confirmation.',
      inputSchema: { ...mutationShape },
      annotations: {
        title: 'Cancel print',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ dry_run, confirmation_token }) =>
      await guard(() => service.cancelPrint(mutationOptions({ dry_run, confirmation_token }))),
  );

  return server;
}

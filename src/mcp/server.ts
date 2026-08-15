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
import type { ModelService } from '../model/service.js';
import { EXPORT_FORMATS, PREVIEW_VIEWS } from '../model/types.js';
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
file deletion are not exposed; printer_capabilities lists them with reasons.

This server also hosts a local CAD workspace (model_* tools). Those tools write
only to a local project directory and run OpenSCAD; they never touch the
printer, so they need no confirmation token. You are the model generator: read
the user's request, write OpenSCAD source yourself, and pass it as \`source\`.
The server does not call any language model. Work iteratively — create or
update the source, render a preview, look at what OpenSCAD reported, and refine
the source before exporting a mesh.`;

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

/**
 * Build an MCP server exposing `service`, and — when supplied — the local CAD
 * workspace. The caller owns the transport.
 */
export function createMcpServer(service: CrealityService, models?: ModelService): McpServer {
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

  if (models !== undefined) registerModelTools(server, models);

  return server;
}

/**
 * CAD workspace tools.
 *
 * These are local-only: they read and write a sandboxed project directory and
 * shell out to OpenSCAD with a fixed argument vector. Nothing here can reach
 * the printer, which is why none of it takes a confirmation token.
 */
function registerModelTools(server: McpServer, models: ModelService): void {
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
  const writes = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  } as const;

  const projectId = z
    .string()
    .describe('Project id, e.g. "cable-clip". Lowercase letters, digits, "-" and "_".');

  server.registerTool(
    'model_toolchain_status',
    {
      title: 'CAD toolchain status',
      description:
        'Whether OpenSCAD is installed and runnable, its version and path. When unavailable, the reason explains how to install it or which environment variable points at it. Call this before promising a preview.',
      inputSchema: {},
      annotations: { ...readOnly, title: 'CAD toolchain status' },
    },
    async () =>
      await guard(async () => ({
        ...(await models.toolchain()),
        workspaceDir: models.config.workspaceDir,
      })),
  );

  server.registerTool(
    'model_project_list',
    {
      title: 'List model projects',
      description:
        'All model projects in the local workspace, newest first, with their prompt, revision, and built artifacts.',
      inputSchema: {},
      annotations: { ...readOnly, title: 'List model projects' },
    },
    async () => await guard(async () => ({ projects: await models.list() })),
  );

  server.registerTool(
    'model_project_read',
    {
      title: 'Read a model project',
      description:
        'The full OpenSCAD source of one project, plus its metadata, revision history, and current artifacts. Read before updating so an edit is based on what is actually on disk.',
      inputSchema: { project_id: projectId },
      annotations: { ...readOnly, title: 'Read a model project' },
    },
    async ({ project_id }) => await guard(() => models.read(project_id)),
  );

  server.registerTool(
    'model_project_create',
    {
      title: 'Create a model project',
      description:
        'Create a project from OpenSCAD source you have written. The prompt is stored verbatim as the durable record of what was asked for; write dimensioned, parametric source (named variables at the top) so later revisions are cheap. Nothing is sent to any cloud service.',
      inputSchema: {
        name: z.string().describe('Human-readable name, e.g. "Cable clip 6mm".'),
        prompt: z.string().describe("The user's request, verbatim."),
        source: z.string().describe('Complete OpenSCAD source. Units are millimetres.'),
        project_id: z
          .string()
          .optional()
          .describe('Explicit id. Defaults to a slug of the name, de-duplicated.'),
      },
      annotations: { ...writes, title: 'Create a model project' },
    },
    async ({ name, prompt, source, project_id }) =>
      await guard(() =>
        models.create({
          name,
          prompt,
          source,
          ...(project_id === undefined ? {} : { id: project_id }),
        }),
      ),
  );

  server.registerTool(
    'model_project_update',
    {
      title: 'Update a model project',
      description:
        'Replace the OpenSCAD source with a new revision. The whole source is replaced, so send the complete file. The project keeps its original prompt; pass `prompt` to record the instruction behind this specific edit. Existing previews and exports are discarded because they no longer match the source.',
      inputSchema: {
        project_id: projectId,
        source: z.string().describe('Complete replacement OpenSCAD source.'),
        prompt: z.string().optional().describe('The instruction behind this revision.'),
        note: z.string().optional().describe('Short changelog note, e.g. "widened the slot".'),
      },
      annotations: { ...writes, idempotentHint: false, title: 'Update a model project' },
    },
    async ({ project_id, source, prompt, note }) =>
      await guard(() =>
        models.update({
          id: project_id,
          source,
          ...(prompt === undefined ? {} : { prompt }),
          ...(note === undefined ? {} : { note }),
        }),
      ),
  );

  server.registerTool(
    'model_render_preview',
    {
      title: 'Render preview images',
      description: `Render PNG previews of the current source (${PREVIEW_VIEWS.join(', ')} by default). Returns one artifact per view plus any OpenSCAD warnings. Fails with TOOL_UNAVAILABLE if OpenSCAD is not installed, and RENDER_FAILED with the compiler diagnostics if the source does not compile — read those and fix the source.`,
      inputSchema: {
        project_id: projectId,
        views: z
          .array(z.enum(PREVIEW_VIEWS))
          .optional()
          .describe(`Subset of ${PREVIEW_VIEWS.join(', ')}. Defaults to all four.`),
        width: z.number().int().optional().describe('Image width in pixels, 160–2048.'),
        height: z.number().int().optional().describe('Image height in pixels, 160–2048.'),
      },
      annotations: { ...writes, title: 'Render preview images' },
    },
    async ({ project_id, views, width, height }) =>
      await guard(() =>
        models.renderPreview({
          id: project_id,
          ...(views === undefined ? {} : { views }),
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
        }),
      ),
  );

  server.registerTool(
    'model_export',
    {
      title: 'Export a mesh',
      description: `Export the current source as ${EXPORT_FORMATS.join(' or ')} into the project's build directory. Returns the artifact path and size. 3MF requires an OpenSCAD build with lib3mf; if it is missing, the error says so.`,
      inputSchema: {
        project_id: projectId,
        format: z.enum(EXPORT_FORMATS).describe('Mesh format to write.'),
      },
      annotations: { ...writes, title: 'Export a mesh' },
    },
    async ({ project_id, format }) =>
      await guard(() => models.export({ id: project_id, format })),
  );
}

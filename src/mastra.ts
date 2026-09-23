import { createTool, type Tool } from '@mastra/core/tools';
import type { PublicSchema } from '@mastra/core/schema';
import { MCPServer } from '@mastra/mcp';
import { CODE_MODE_INSTRUCTIONS, createCodeModeTools } from './code-mode.js';
import { createUpapiToolSpecs, type CreateToolsOptions, type UpapiToolSpec } from './tools.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';

/**
 * Mastra bindings: upAPI's operations as Mastra tools, and an `MCPServer` that
 * serves them over stdio.
 *
 * The operation's JSON Schema is handed to `createTool` unchanged — Mastra's
 * `PublicSchema` accepts a JSON Schema alongside Zod, so nothing is re-declared
 * or converted, and `tools/list` advertises exactly what the worker validates.
 *
 * `MCP_TOOL_SURFACE` picks WHAT `createUpapiMcpServer` advertises:
 *
 *  - `codemode` (default) — `search_tools` + `execute_typescript` only (see
 *    `code-mode.ts`). Flat regardless of catalog size, and the shape a model
 *    that can write a few lines of TypeScript gets the most out of.
 *  - `full` — one tool per operation, today's `createUpapiTools` table. Kept
 *    for anyone who already built against this module's `full` shape, and
 *    documented as the rollback switch for Code Mode.
 *  - `both` — the union, for exercising or migrating off of one surface
 *    without breaking the other mid-transition.
 *
 * Environment, mirroring `stdio.ts`'s `resolveStdioToolMode`: an MCP client
 * config file can set nothing else, and an unrecognized value falls back to
 * the default rather than refusing to start.
 */
export type McpToolSurface = 'codemode' | 'full' | 'both';

const TOOL_SURFACES: readonly McpToolSurface[] = ['codemode', 'full', 'both'];

/** Narrow an untrusted string to a surface. Unknown values are NOT a surface. */
export function parseMcpToolSurface(value: string | null | undefined): McpToolSurface | undefined {
  return TOOL_SURFACES.find((surface) => surface === value);
}

/** The surface named by `MCP_TOOL_SURFACE`, or `codemode`. */
export function resolveMcpToolSurface(env: NodeJS.ProcessEnv = process.env): McpToolSurface {
  return parseMcpToolSurface(env['MCP_TOOL_SURFACE']) ?? 'codemode';
}

// Re-exported for compatibility: these are part of this module's public surface
// and the barrel re-exports them from here. They LIVE in ./meta.js so that
// http.ts can read them without importing Mastra — see that file's header.
export { SERVER_NAME, SERVER_VERSION };

/**
 * The tool map for a Mastra agent: `new Agent({ tools: createUpapiTools({ caller }) })`.
 * Keys are MCP tool names, so an agent's tool names match what an MCP client sees.
 */
export function createUpapiTools(options: CreateToolsOptions): Record<string, Tool> {
  const tools: Record<string, Tool> = {};
  for (const spec of createUpapiToolSpecs(options)) {
    tools[spec.name] = toMastraTool(spec);
  }
  return tools;
}

function toMastraTool(spec: UpapiToolSpec): Tool {
  return createTool({
    id: spec.name,
    description: spec.description,
    // A JSON Schema, passed through verbatim (see the module doc).
    inputSchema: spec.inputSchema as PublicSchema,
    // Resolves with the operation's output and THROWS on failure. Mastra (and the
    // MCP server built on it) turns a thrown error into a tool-level error result,
    // which is what an agent should see — a failed operation is a normal outcome,
    // not a reason to break the session.
    execute: async (inputData: unknown) => spec.execute(inputData),
  });
}

export type CreateMcpServerOptions = CreateToolsOptions & {
  name?: string | undefined;
  version?: string | undefined;
  /** Which tools to advertise. Defaults to `resolveMcpToolSurface()`. */
  surface?: McpToolSurface | undefined;
};

/** The tool map for the requested surface. Exported for tests and byte-size measurement. */
export function createToolsForSurface(
  options: CreateToolsOptions,
  surface: McpToolSurface,
): Record<string, Tool> {
  if (surface === 'full') return createUpapiTools(options);
  if (surface === 'both') return { ...createUpapiTools(options), ...createCodeModeTools(options) };
  return createCodeModeTools(options);
}

/**
 * An `MCPServer` exposing upAPI's operations, shaped by `MCP_TOOL_SURFACE` (or
 * `options.surface`): `codemode`'s two meta-tools by default, `full`'s one
 * tool per operation as a rollback, or `both` while migrating between them.
 *
 * `instructions` carries the Code Mode contract whenever a `codemode` tool is
 * on the table (`codemode` and `both`) — the two meta-tools are meaningless to
 * a model that was not told to write TypeScript against them.
 *
 * Transport is the caller's choice — `await server.startStdio()` for a local
 * subprocess server (what the `upapi-mcp` bin does). The hosted HTTP endpoint
 * uses `handleUpapiMcpRequest` (`@upapi/mcp/http`) instead, because a Next route
 * handler speaks web-standard `Request`/`Response` rather than Node's `http`.
 */
export function createUpapiMcpServer(options: CreateMcpServerOptions): MCPServer {
  const surface = options.surface ?? resolveMcpToolSurface();
  return new MCPServer({
    name: options.name ?? SERVER_NAME,
    version: options.version ?? SERVER_VERSION,
    tools: createToolsForSurface(options, surface),
    ...(surface === 'full' ? {} : { instructions: CODE_MODE_INSTRUCTIONS }),
  });
}

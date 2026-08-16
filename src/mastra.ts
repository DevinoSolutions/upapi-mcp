import { createTool } from '@mastra/core/tools';
import type { PublicSchema } from '@mastra/core/schema';
import { MCPServer } from '@mastra/mcp';
import { createUpapiToolSpecs, type CreateToolsOptions, type UpapiToolSpec } from './tools.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';

/**
 * Mastra bindings: upAPI's operations as Mastra tools, and an `MCPServer` that
 * serves them over stdio.
 *
 * The operation's JSON Schema is handed to `createTool` unchanged — Mastra's
 * `PublicSchema` accepts a JSON Schema alongside Zod, so nothing is re-declared
 * or converted, and `tools/list` advertises exactly what the worker validates.
 */

// Re-exported for compatibility: these are part of this module's public surface
// and the barrel re-exports them from here. They LIVE in ./meta.js so that
// http.ts can read them without importing Mastra — see that file's header.
export { SERVER_NAME, SERVER_VERSION };

/**
 * The tool map for a Mastra agent: `new Agent({ tools: createUpapiTools({ caller }) })`.
 * Keys are MCP tool names, so an agent's tool names match what an MCP client sees.
 */
export function createUpapiTools(
  options: CreateToolsOptions,
): Record<string, ReturnType<typeof createTool>> {
  const tools: Record<string, ReturnType<typeof createTool>> = {};
  for (const spec of createUpapiToolSpecs(options)) {
    tools[spec.name] = toMastraTool(spec);
  }
  return tools;
}

function toMastraTool(spec: UpapiToolSpec): ReturnType<typeof createTool> {
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
};

/**
 * An `MCPServer` exposing one tool per public upAPI operation.
 *
 * Transport is the caller's choice — `await server.startStdio()` for a local
 * subprocess server (what the `upapi-mcp` bin does). The hosted HTTP endpoint
 * uses `handleUpapiMcpRequest` (`@upapi/mcp/http`) instead, because a Next route
 * handler speaks web-standard `Request`/`Response` rather than Node's `http`.
 */
export function createUpapiMcpServer(options: CreateMcpServerOptions): MCPServer {
  return new MCPServer({
    name: options.name ?? SERVER_NAME,
    version: options.version ?? SERVER_VERSION,
    tools: createUpapiTools(options),
  });
}

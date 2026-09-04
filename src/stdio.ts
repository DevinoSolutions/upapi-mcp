import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createUpapiToolSpecs,
  isDirectoryListedOperation,
  type CreateToolsOptions,
} from './tools.js';
import {
  createFacadeEntries,
  toolNotFound,
  CALL_OP_TOOL_NAME,
  SEARCH_OPS_TOOL_NAME,
} from './facade.js';
import { parseToolMode, selectListedTools, type McpToolMode } from './table.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';

/**
 * MCP over stdio — the local server the `upapi-mcp` bin runs, and the server a
 * Claude Desktop Extension (`packages/mcpb`) starts as a subprocess.
 *
 * Built on the MCP SDK's low-level `Server`, NOT on Mastra's `MCPServer`, for
 * two reasons that are both load-bearing rather than stylistic:
 *
 *  1. **Annotations reach the wire.** Mastra's `createTool` has no field for the
 *     four behavioural hints, so every tool this server used to advertise
 *     arrived at the client with its behaviour unstated — and `readOnlyHint` /
 *     `destructiveHint` on every tool is a hard requirement of both directory
 *     review criteria we are shipping against. The hosted transport already
 *     emitted them; stdio silently did not.
 *  2. **Install size.** @mastra/core alone unpacks to ~65 MB before its own
 *     dependency tree (`ai`, `express`), which is why Mastra is a peer here
 *     rather than a dependency: a `.mcpb` bundle vendors its `node_modules`, and
 *     that tree is not shippable inside a desktop extension.
 *
 * The Mastra bindings are NOT deleted — `@upapi/mcp/mastra` still exports
 * `createUpapiTools` and `createUpapiMcpServer` for anyone building a Mastra
 * agent. They are simply no longer on the path a plain MCP client takes.
 *
 * One tool table, as everywhere else: the specs come from `createUpapiToolSpecs`
 * and the listing from `selectListedTools`, exactly as the hosted transport does.
 */

export type CreateStdioServerOptions = CreateToolsOptions & {
  name?: string | undefined;
  version?: string | undefined;
  /**
   * Which table to advertise. Defaults to `full` — one tool per operation, the
   * surface every existing `npx -y @upapi/mcp` install was configured against.
   */
  mode?: McpToolMode | undefined;
};

/**
 * The mode named by `UPAPI_TOOL_MODE`, or `full`.
 *
 * Environment, because an MCP client config file can set nothing else — the
 * same reason the API key arrives that way. An unrecognized value falls back to
 * the default rather than refusing to start: a typo in a config file must not
 * leave a user with a server that will not boot and no way to see why.
 */
export function resolveStdioToolMode(env: NodeJS.ProcessEnv = process.env): McpToolMode {
  return parseToolMode(env['UPAPI_TOOL_MODE']) ?? 'full';
}

/**
 * An MCP server over stdio exposing upAPI's operations.
 *
 * `directory` mode additionally applies the hosted transport's withheld-category
 * exclusion. That exclusion is about what a PUBLIC LISTING advertises to someone
 * who clicked "install", which is precisely what a directory-mode stdio server
 * is — unlike `full`/`compact`, which a developer wires up deliberately with
 * their own key and which therefore keep serving the whole catalog.
 */
export function createUpapiStdioServer(options: CreateStdioServerOptions): Server {
  const mode = options.mode ?? 'full';
  const specs = createUpapiToolSpecs({
    ...options,
    filter: (op) =>
      (mode === 'directory' ? isDirectoryListedOperation(op) : true) &&
      (options.filter?.(op) ?? true),
  });
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const { search, call } = createFacadeEntries(specs);
  const listed = selectListedTools(specs, { mode, canExecute: true, canSearch: true });

  const server = new Server(
    { name: options.name ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listed.map((spec) => ({
      name: spec.name,
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      // Copied, not passed by reference: one annotations object is shared by
      // every operation in its class, so a handler downstream that mutated it
      // would relabel all of them.
      annotations: { ...spec.annotations },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    // The two meta-tools stay dispatchable in every mode, listed or not: the
    // table is a presentation decision and `specs` is the access decision, so a
    // client that already knows the names reaches exactly what it could reach
    // anyway — and nothing more, since `call_op` resolves against these specs.
    if (name === SEARCH_OPS_TOOL_NAME) return search.call(args);
    if (name === CALL_OP_TOOL_NAME) return call.call(args);

    const spec = byName.get(name);
    if (!spec) return toolNotFound(name);
    return spec.call(args);
  });

  return server;
}

/** Create the server and serve it on stdin/stdout until the client disconnects. */
export async function startUpapiStdioServer(options: CreateStdioServerOptions): Promise<Server> {
  const server = createUpapiStdioServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

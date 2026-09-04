import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  createUpapiToolSpecs,
  isDirectoryListedOperation,
  type CreateToolsOptions,
} from './tools.js';
import {
  createFacadeEntries,
  toolForbidden,
  toolNotFound,
  CALL_OP_TOOL_NAME,
  EXECUTE_FORBIDDEN_MESSAGE,
  SEARCH_FORBIDDEN_MESSAGE,
  SEARCH_OPS_TOOL_NAME,
} from './facade.js';
import { parseToolMode, selectListedTools, type McpToolMode } from './table.js';
import { SERVER_NAME, SERVER_VERSION } from './meta.js';

/**
 * MCP over streamable HTTP, for a web-standard `Request` → `Response` handler
 * (a Next.js route, a Worker, Hono).
 *
 * Built on the MCP SDK's low-level `Server` rather than Mastra's `MCPServer`
 * because Mastra's HTTP transports speak Node's `http` or Hono, while a Next
 * route handler is handed a `Request` — and because the low-level server lets
 * each operation's JSON Schema go onto the wire verbatim.
 *
 * STATELESS, one server + transport per request. The hosted endpoint runs behind
 * a load balancer across container instances, so any in-memory session would be
 * a coin flip on which instance the client's next request landed. Statelessness
 * also matters for authorization: the caller's identity is re-established from
 * their access token on EVERY request, so a tool can never execute against a
 * session that outlived the token that opened it.
 *
 * THREE TOOL TABLES, ONE ACCESS DECISION. `?tools=full` serves one tool per
 * operation; `?tools=directory` serves the curated, named, read/write-separated
 * listing an AI marketplace reviews (see `directory.ts`); the default serves the
 * compact facade (`search_ops` + `call_op` + a few always-on operations) so a
 * connection does not re-send tens of kilobytes of JSON Schema on every turn.
 * All three are built from the SAME filtered `specs` by the SAME
 * `selectListedTools`, so the mode changes what is ADVERTISED and never what is
 * reachable.
 *
 * This module imports NOTHING from Mastra, and must not start: it is reachable
 * as the `@upapi/mcp/http` subpath precisely so a host that file-traces its
 * route bundle (Next's `output: 'standalone'`) ships only the MCP SDK. Reaching
 * for a constant or a type in `./mastra.js` from here would put @mastra/core and
 * @mastra/mcp back in a production image that never runs a Mastra agent.
 */

export type McpHttpOptions = CreateToolsOptions & {
  name?: string | undefined;
  version?: string | undefined;
  /** Overrides the `?tools=` query parameter. Defaults to `resolveToolMode(request)`. */
  mode?: McpToolMode | undefined;
  /**
   * Whether this caller may RUN operations. False hides every executable tool
   * and refuses a call to one; the host decides what that means (upAPI maps it
   * to the access token's `ops:execute` scope). Defaults to true so a host that
   * has no scope model is unaffected.
   */
  canExecute?: boolean | undefined;
  /** Whether this caller may SEARCH the catalog. Defaults to true. */
  canSearch?: boolean | undefined;
};

/**
 * Re-exported so a host can type its `caller` off this subpath alone — importing
 * it from the barrel would defeat the point of the subpath (see above).
 */
export type { Caller } from './tools.js';

/**
 * The tool table's own building blocks, re-exported here for the same reason
 * `Caller` is: a host that must assemble its OWN table — the in-app AI copilot
 * builds AI SDK tools rather than MCP tools — needs the specs and the facade,
 * and reaching for them through the barrel would put @mastra/core back into a
 * traced production bundle. Everything below comes from `./tools.js`,
 * `./facade.js`, and `./errors.js`, none of which import Mastra; adding a
 * re-export from `./mastra.js` here would silently undo that.
 *
 * There is exactly ONE tool registry in this product and this is how a second
 * transport consumes it. A host that copies the catalog into a table of its own
 * has forked the registry, and the two will disagree the first time an operation
 * is added.
 */
export {
  createUpapiToolSpecs,
  isDirectoryListedOperation,
  DIRECTORY_EXCLUDED_CATEGORIES,
  DIRECTORY_EXCLUDED_SLUGS,
  OPERATION_ANNOTATIONS,
  type CreateToolsOptions,
  type McpToolAnnotations,
  type ToolCallResult,
  type ToolContent,
  type ToolFilter,
  type UpapiToolSpec,
} from './tools.js';

export {
  createFacadeEntries,
  toolForbidden,
  toolNotFound,
  ALWAYS_ON_SLUGS,
  CALL_OP_TOOL_NAME,
  SEARCH_OPS_TOOL_NAME,
  EXECUTE_FORBIDDEN_MESSAGE,
  SEARCH_FORBIDDEN_MESSAGE,
  type McpToolEntry,
} from './facade.js';

export {
  createDirectoryEntries,
  DIRECTORY_FLAGSHIP_SLUGS,
  type DirectoryEntries,
} from './directory.js';

export {
  parseToolMode,
  selectListedTools,
  type McpToolMode,
  type SelectListedToolsOptions,
} from './table.js';

export { formatToolFailure, toToolFailure, type ToolFailure } from './errors.js';

/**
 * The mode a request asks for: `?tools=full`, `?tools=directory`, else compact.
 *
 * A query parameter rather than a header or a separate route because an MCP
 * client is configured with ONE URL and re-sends it verbatim; anything that
 * cannot be expressed in that URL cannot be chosen by the user who installs it.
 * Unknown values fall back to compact rather than erroring — a typo must not
 * take a working connection down, and compact is the safe default.
 */
export function resolveToolMode(request: Request): McpToolMode {
  try {
    return parseToolMode(new URL(request.url).searchParams.get('tools')) ?? 'compact';
  } catch {
    return 'compact';
  }
}

/**
 * Serve one MCP request. Build the `caller` from the AUTHENTICATED identity of
 * this request and pass it in — that is the whole mechanism by which the hosted
 * endpoint stays tied to the platform's own auth and metering.
 */
export async function handleUpapiMcpRequest(
  request: Request,
  options: McpHttpOptions,
): Promise<Response> {
  // The directory exclusion is applied HERE, and it is not one of the options a
  // host can pass. This is the surface an AI marketplace lists, so what it
  // advertises has to be a property of the transport rather than of whichever
  // call site mounted it — a caller's own `filter` narrows further, never wider.
  // The stdio server (`createUpapiMcpServer`) is untouched and still serves the
  // whole catalog: it is installed by a developer with their own key, not
  // offered to anyone browsing a connector list.
  const specs = createUpapiToolSpecs({
    ...options,
    filter: (op) => isDirectoryListedOperation(op) && (options.filter?.(op) ?? true),
  });
  const byName = new Map(specs.map((spec) => [spec.name, spec]));

  const canExecute = options.canExecute ?? true;
  const canSearch = options.canSearch ?? true;
  const mode = options.mode ?? resolveToolMode(request);
  const { search, call } = createFacadeEntries(specs);

  // What tools/list ADVERTISES. Dispatch below is deliberately wider — see
  // `selectListedTools`, which owns this decision for both transports.
  const listed = selectListedTools(specs, { mode, canExecute, canSearch });

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
      // The four behavioural hints go on the wire so a client deciding whether
      // it may run a tool unattended reads upAPI's own declaration
      // (OPERATION_ANNOTATIONS in ./tools.ts) instead of inferring one from the
      // tool's name. Copied rather than passed by reference because one
      // annotations object is shared by every operation in its class, and a
      // handler downstream that mutated it would relabel all of them.
      annotations: { ...spec.annotations },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    if (name === SEARCH_OPS_TOOL_NAME) {
      return canSearch ? search.call(args) : toolForbidden(SEARCH_FORBIDDEN_MESSAGE);
    }
    if (name === CALL_OP_TOOL_NAME) {
      return canExecute ? call.call(args) : toolForbidden(EXECUTE_FORBIDDEN_MESSAGE);
    }

    const spec = byName.get(name);
    // A tool the caller cannot see is reported as a failed CALL, not a protocol
    // error, and the text says nothing about why it is absent — the tool table
    // is already filtered to what this caller may invoke.
    if (!spec) return toolNotFound(name);
    // A REAL tool withheld for lack of authorization says so, unlike an absent
    // one: this caller holds the token, so naming the reason costs no secret and
    // is the difference between "fix your grant" and "upAPI is broken".
    if (!canExecute) return toolForbidden(EXECUTE_FORBIDDEN_MESSAGE);
    return spec.call(args);
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Answer with a plain JSON body instead of opening an SSE stream: there is
    // nothing to stream (a tool call is one request/one result) and a long-lived
    // stream through the edge is a liability, not a feature, on this deployment.
    enableJsonResponse: true,
  });

  await server.connect(transport);

  const response = await transport.handleRequest(request);

  // JSON responses are fully materialized, so buffer and tear down rather than
  // leaving a transport (and its timers) alive per request. An event-stream
  // response would still be open, so it is passed through untouched.
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    return response;
  }
  const body = await response.text();
  await transport.close();
  await server.close();
  return new Response(body.length > 0 ? body : null, {
    status: response.status,
    headers: response.headers,
  });
}

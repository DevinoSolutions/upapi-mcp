/**
 * @upapi/mcp — every public upAPI operation as an MCP tool.
 *
 * Two transports, one tool table, no auth logic of its own:
 *
 *  - **Local (stdio)** — `createUpapiStdioServer` + the `upapi-mcp` bin.
 *    Forwards to api.upapi.io with the user's `upapi_` key; the key is validated
 *    at the gateway, never here. Reaches the whole catalog, and defaults to the
 *    same compact
 *    `search_ops`/`call_op` facade the hosted transport defaults to
 *    (`UPAPI_TOOL_MODE`, rollback `full`). Mastra bindings for the same table
 *    live behind the `@upapi/mcp/mastra` subpath, whose peer dependencies are
 *    optional — importing this barrel must not require @mastra/core to be
 *    installed.
 *  - **Hosted (HTTP)** — `handleUpapiMcpRequest`, mounted by the web app behind
 *    its own better-auth OAuth. Tool execution runs in-process through the same
 *    invocation + metering path the try-it panel uses. It serves the same whole
 *    catalog (since 2026-09-26; it used to withhold Social Media and Utility),
 *    and advertises a SMALLER table by default — the compact
 *    `search_ops`/`call_op` facade, with the per-op table of every public
 *    operation behind `?tools=full` and the curated, named, read/write-separated
 *    directory listing behind `?tools=directory` (and the narrower Claude
 *    listing behind `?tools=claude`).
 *
 * Both get their operations from @upapi/sdk's generated catalog and differ only
 * in the injected `Caller`.
 */
/**
 * The catalog the tool table is built from, re-exported so a consumer can write
 * a `filter` (or list what a server will expose) without also depending on
 * @upapi/sdk.
 */
export { OPERATIONS, type OperationMeta } from '@upapi/sdk';

export {
  createUpapiToolSpecs,
  OPERATION_ANNOTATIONS,
  type Caller,
  type CreateToolsOptions,
  type McpToolAnnotations,
  type ToolCallResult,
  type ToolContent,
  type ToolFilter,
  type UpapiToolSpec,
} from './tools.js';

export { SERVER_NAME, SERVER_VERSION } from './meta.js';

export {
  createUpapiStdioServer,
  resolveStdioToolMode,
  startUpapiStdioServer,
  type CreateStdioServerOptions,
} from './stdio.js';

export {
  CLAUDE_LISTING_SLUGS,
  createClaudeEntries,
  createDirectoryEntries,
  DIRECTORY_FLAGSHIP_SLUGS,
  OWN_FILES_NOTICE,
  type DirectoryEntries,
} from './directory.js';

export {
  parseToolMode,
  selectListedTools,
  type McpToolMode,
  type SelectListedToolsOptions,
} from './table.js';

export { handleUpapiMcpRequest, resolveToolMode, type McpHttpOptions } from './http.js';

export {
  createFacadeEntries,
  toolForbidden,
  toolNotFound,
  ALWAYS_ON_SLUGS,
  CALL_OP_TOOL_NAME,
  EXECUTE_FORBIDDEN_MESSAGE,
  SEARCH_FORBIDDEN_MESSAGE,
  SEARCH_OPS_TOOL_NAME,
  type McpToolEntry,
} from './facade.js';

export { createGatewayCaller } from './caller.js';

export { formatToolFailure, toToolFailure, type ToolFailure } from './errors.js';

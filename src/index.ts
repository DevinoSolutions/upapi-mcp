/**
 * @upapi/mcp — every public upAPI operation as an MCP tool.
 *
 * Two transports, one tool table, no auth logic of its own:
 *
 *  - **Local (stdio)** — `createUpapiMcpServer` + the `upapi-mcp` bin. Forwards
 *    to api.upapi.io with the user's `upapi_` key; the key is validated at the
 *    gateway, never here.
 *  - **Hosted (HTTP)** — `handleUpapiMcpRequest`, mounted by the web app behind
 *    its own better-auth OAuth. Tool execution runs in-process through the same
 *    invocation + metering path the try-it panel uses. This is the surface AI
 *    directories list, so it serves a NARROWER table: see
 *    `DIRECTORY_EXCLUDED_CATEGORIES`. It also serves a SMALLER one by default —
 *    the compact `search_ops`/`call_op` facade, with the per-op table behind
 *    `?tools=full`.
 *
 * Both get their operations from @upapi/sdk's generated catalog and differ only
 * in the injected `Caller` and in that listing scope.
 */
/**
 * The catalog the tool table is built from, re-exported so a consumer can write
 * a `filter` (or list what a server will expose) without also depending on
 * @upapi/sdk.
 */
export { OPERATIONS, type OperationMeta } from '@upapi/sdk';

export {
  createUpapiToolSpecs,
  DIRECTORY_EXCLUDED_CATEGORIES,
  isDirectoryListedOperation,
  OPERATION_ANNOTATIONS,
  type Caller,
  type CreateToolsOptions,
  type McpToolAnnotations,
  type ToolCallResult,
  type ToolContent,
  type ToolFilter,
  type UpapiToolSpec,
} from './tools.js';

export {
  createUpapiMcpServer,
  createUpapiTools,
  SERVER_NAME,
  SERVER_VERSION,
  type CreateMcpServerOptions,
} from './mastra.js';

export {
  handleUpapiMcpRequest,
  resolveToolMode,
  type McpHttpOptions,
  type McpToolMode,
} from './http.js';

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

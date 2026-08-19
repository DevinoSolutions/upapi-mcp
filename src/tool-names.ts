/**
 * The two facade tool names, and NOTHING ELSE.
 *
 * A leaf on purpose: this file imports nothing, so importing it pulls nothing
 * in. That is the entire reason it exists separately from `facade.ts`.
 *
 * The names are needed by code that has no business loading an MCP server —
 * upAPI's copilot PANEL reads them to decide how to label a tool chip, and it
 * runs in the browser. Taking them from `./http.js` (which is where they were
 * re-exported from) drags the MCP SDK, its transport, and ajv into that import
 * graph: roughly 300 KB of server-side machinery reachable from a React
 * component, kept out of the bundle today only by the bundler's tree-shaking
 * deciding to be clever. This makes it structural instead of fortunate.
 *
 * `facade.ts` re-exports these rather than declaring its own, so there is still
 * exactly one definition of each name.
 */

/** Discovery: search the operations THIS connection is allowed to see. */
export const SEARCH_OPS_TOOL_NAME = 'search_ops';

/** Execution: run one operation by slug. */
export const CALL_OP_TOOL_NAME = 'call_op';

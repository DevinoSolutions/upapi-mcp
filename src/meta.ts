/**
 * Server identity, in a module of its own so that importing it costs nothing.
 *
 * These two strings used to live in `mastra.ts`, which meant `http.ts` — the
 * hosted transport — pulled @mastra/core and @mastra/mcp into its import graph
 * to read a name and a version. Next file-traces the route bundle, so that put
 * the whole Mastra dependency tree in the production runner image for two
 * constants. Keep them here; nothing else belongs in this file.
 */

export const SERVER_NAME = 'upAPI';
export const SERVER_VERSION = '0.1.0';

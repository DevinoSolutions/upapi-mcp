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

/**
 * The version an MCP client sees in `initialize`.
 *
 * Must equal this package's `version`. It cannot BE that value — a JSON import
 * would need an import attribute and would land in every consumer's bundle — so
 * `registry-metadata.test.ts` reads package.json and fails on a drift — which is how
 * this stayed at `0.1.0` through three releases before anyone noticed.
 */
export const SERVER_VERSION = '0.2.0';

/**
 * The icon an MCP client shows beside this server in `initialize`
 * (serverInfo.icons, MCP 2025-11-25): the app icon tile (T-11031), the same
 * hosted 512 PNG `server.json` lists first for the registry.
 */
export const SERVER_ICONS = [
  { src: 'https://upapi.io/icons/icon-512.png', mimeType: 'image/png', sizes: ['512x512'] },
];

#!/usr/bin/env node
import { createGatewayCaller } from './caller.js';
import { createUpapiMcpServer } from './mastra.js';

/**
 * `upapi-mcp` — a local stdio MCP server for upAPI.
 *
 * Configured entirely by environment, because that is the only thing an MCP
 * client config file can set:
 *
 *   UPAPI_API_KEY   (required)  an `upapi_` key from app.upapi.io → API Keys
 *   UPAPI_BASE_URL  (optional)  gateway origin; defaults to https://api.upapi.io
 *
 * The key is NOT validated here — only checked for presence, so a missing one
 * fails immediately with a readable message instead of surfacing later as an
 * unexplained 401 inside an agent's tool call. Whether the key is real, expired,
 * or over quota is decided at the gateway, which is the one place that answers
 * that question for any machine caller.
 *
 * stdout belongs to the MCP protocol. Everything this process says to a human
 * goes to stderr, or it corrupts the stream.
 */

async function main(): Promise<void> {
  const apiKey = process.env['UPAPI_API_KEY'];
  if (!apiKey) {
    process.stderr.write(
      'upapi-mcp: UPAPI_API_KEY is not set.\n' +
        '  Create a key at https://app.upapi.io/dashboard/api-keys and pass it to the server, e.g.\n' +
        '    claude mcp add upapi -e UPAPI_API_KEY=upapi_... -- npx -y @upapi/mcp\n',
    );
    process.exit(1);
  }

  const baseUrl = process.env['UPAPI_BASE_URL'];
  const server = createUpapiMcpServer({
    caller: createGatewayCaller({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
  });

  await server.startStdio();
}

main().catch((err: unknown) => {
  process.stderr.write(`upapi-mcp: failed to start — ${(err as Error).message}\n`);
  process.exit(1);
});

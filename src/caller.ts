import { UpAPI, type UpAPIOptions } from '@upapi/sdk';
import type { Caller } from './tools.js';

/**
 * A `Caller` that forwards to the public gateway with the user's API key.
 *
 * This is the LOCAL transport's execution path. It validates nothing itself: the
 * key is checked at api.upapi.io, the single choke point every machine caller
 * goes through, so an MCP server can neither widen nor narrow what a key is
 * allowed to do. `UpAPIError` already carries `{code, message, status,
 * retryAfterSeconds}`, which is exactly what the tool-failure formatter reads.
 */
export function createGatewayCaller(options: UpAPIOptions): Caller {
  const client = new UpAPI(options);
  return (slug, input) => client.call(slug, input);
}

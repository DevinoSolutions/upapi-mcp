import { UpAPI, type UpAPIOptions } from '@upapi/sdk';
import type { Caller } from './tools.js';
import { DenialError, type Denial } from './denial.js';
import type { AccountCaller } from './account-tools.js';

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

/** Posts to the gateway's key-authenticated account route; the SERVER enforces tiers, confirm tokens and audit. */
export function createGatewayAccountCaller(options: {
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}): AccountCaller {
  const base = (options.baseUrl ?? 'https://api.upapi.io').replace(/\/+$/, '');
  const f = options.fetchImpl ?? fetch;
  return async (tool, input) => {
    const res = await f(`${base}/account-tools/${encodeURIComponent(tool)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': options.apiKey },
      body: JSON.stringify(input),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // A non-JSON edge page: reported below as a gateway failure with the status.
    }
    if (res.ok) return body;
    const b = body as (Denial & { error?: Denial }) | null;
    const d = b && typeof b.code === 'string' ? b : (b?.error ?? null);
    throw new DenialError(
      d ?? { code: 'TOOL_FAILED', message: `The gateway answered ${res.status}.` },
    );
  };
}

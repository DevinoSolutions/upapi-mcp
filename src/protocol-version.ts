import { readRequestBody } from '@modelcontextprotocol/sdk/server/requestBody.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';

/**
 * The MCP 2026-07-28 answer to a request for a protocol version this server does
 * not speak (T-13340, 2026-11-03).
 *
 * claude.ai opens every connection with `server/discover` and
 * `MCP-Protocol-Version: 2026-07-28`. The SDK transport (1.32, which speaks up to
 * 2025-11-25) refuses that with HTTP 400 and a generic `-32000 "Bad Request:
 * Unsupported protocol version"`. Claude Code and ChatGPT read that as "legacy
 * server" and fall back to `initialize`; claude.ai does not retry, so its users
 * connected, consented and got no tools. The spec's answer is HTTP 400 with an
 * `UnsupportedProtocolVersionError` (-32022) listing the versions the server
 * speaks in `data.supported`, which tells the client to retry on one of them.
 *
 * Left to the SDK untouched, exactly as before: no header (or an empty one), a
 * supported version, an `initialize` anywhere in the body (it carries its version
 * in the body and the SDK negotiates it there, so legacy clients see no change), a
 * body over the transport's size limit (its own 413) and a body that is not JSON
 * (its own -32700). `data.supported` is the SDK's own list, never a hand copy, so
 * an SDK upgrade that learns a version is answered correctly without an edit here.
 */

/** JSON-RPC code of `UnsupportedProtocolVersionError` (MCP 2026-07-28, basic/lifecycle). */
const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

type ProtocolVersionRefusal = {
  response: Response;
  /** The version the client asked for, verbatim and caller-chosen: cap it before logging it. */
  requested: string;
  /** The JSON-RPC method of a single-message body, else null (a batch, a GET). Caller-chosen. */
  method: string | null;
};

/**
 * The body's JSON-RPC messages, read from a CLONE so the transport still reads the
 * original. Null hands the request to the SDK: over its size limit, or not JSON.
 * Read with the SDK's own reader and default bound, so "too large" means exactly
 * what the transport's 413 means.
 */
async function readMessages(request: Request): Promise<unknown[] | null> {
  if (request.method !== 'POST') return [];
  const body = await readRequestBody(request.clone());
  if (body.tooLarge) return null;
  try {
    const parsed: unknown = JSON.parse(body.text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Not JSON: the transport answers that itself (-32700), as before T-13340.
    return null;
  }
}

function field(message: unknown, name: 'method' | 'id'): unknown {
  return typeof message === 'object' && message !== null ? Reflect.get(message, name) : undefined;
}

/** The -32022 answer for `request`, or null when the SDK should handle it. */
export async function refuseUnsupportedProtocolVersion(
  request: Request,
): Promise<ProtocolVersionRefusal | null> {
  const requested = request.headers.get('mcp-protocol-version');
  if (!requested || SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) return null;

  const messages = await readMessages(request);
  if (messages === null) return null;
  if (messages.some((message) => field(message, 'method') === 'initialize')) return null;

  // The id is echoed only when there is exactly one message to answer; a batch or
  // a bodiless request gets null, as JSON-RPC prescribes for an unattributable error.
  const single = messages.length === 1 ? messages[0] : undefined;
  const id = field(single, 'id');
  const method = field(single, 'method');
  return {
    requested,
    method: typeof method === 'string' ? method : null,
    response: Response.json(
      {
        jsonrpc: '2.0',
        id: typeof id === 'string' || typeof id === 'number' ? id : null,
        error: {
          code: UNSUPPORTED_PROTOCOL_VERSION_CODE,
          message: `Unsupported protocol version: ${requested}`,
          data: { supported: SUPPORTED_PROTOCOL_VERSIONS, requested },
        },
      },
      { status: 400 },
    ),
  };
}

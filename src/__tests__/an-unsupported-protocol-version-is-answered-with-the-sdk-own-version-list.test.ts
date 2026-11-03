import { describe, expect, it, vi } from 'vitest';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '@modelcontextprotocol/sdk/server/requestBody.js';
import { handleUpapiMcpRequest, type Caller } from '../http.js';

/**
 * T-13340, at the package boundary. The route-level proof (real auth, real
 * transport) lives in apps/web
 * `a-client-asking-for-a-protocol-version-we-do-not-speak-is-told-which-ones-we-do.test.ts`;
 * this pins what the web app cannot import: `data.supported` IS the SDK's own
 * list, the host hook fires once and can never change the answer, and a body over
 * the transport's size limit still gets the transport's own 413.
 */

const caller: Caller = vi.fn(async () => ({ ok: true }));

function discover(body: string): Request {
  return new Request('https://app.upapi.io/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
    },
    body,
  });
}

const SERVER_DISCOVER = JSON.stringify({
  jsonrpc: '2.0',
  id: 7,
  method: 'server/discover',
  params: {},
});

describe('a request for a protocol version the SDK does not speak', () => {
  it("lists exactly the SDK's supported versions and reports the refusal once", async () => {
    const onUnsupportedProtocolVersion = vi.fn();

    const res = await handleUpapiMcpRequest(discover(SERVER_DISCOVER), {
      caller,
      onUnsupportedProtocolVersion,
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; data: { supported: unknown } } };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    expect(onUnsupportedProtocolVersion).toHaveBeenCalledTimes(1);
    expect(onUnsupportedProtocolVersion).toHaveBeenCalledWith('2026-07-28', 'server/discover');
  });

  it('answers exactly the same when the hook throws', async () => {
    const res = await handleUpapiMcpRequest(discover(SERVER_DISCOVER), {
      caller,
      onUnsupportedProtocolVersion: () => {
        throw new Error('telemetry down');
      },
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32022);
  });

  it("leaves a body over the transport's size limit to the transport's own 413, unreported", async () => {
    const onUnsupportedProtocolVersion = vi.fn();
    const oversize = JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'server/discover',
      params: { pad: 'x'.repeat(DEFAULT_MAX_REQUEST_BODY_SIZE) },
    });

    const res = await handleUpapiMcpRequest(discover(oversize), {
      caller,
      onUnsupportedProtocolVersion,
    });

    expect(res.status).toBe(413);
    expect(onUnsupportedProtocolVersion).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { handleUpapiMcpRequest, type Caller, type McpHttpOptions } from '../http.js';

/**
 * `onUnknownTool`: a `tools/call` naming a tool this request does not serve is
 * reported to the host, and the answer is exactly the `NOT_FOUND` it always
 * was. Observability only — the hook can neither change nor fail the call.
 */

const caller: Caller = vi.fn(async () => ({ ok: true }));

function callTool(name: string, search = ''): Request {
  return new Request(`https://app.upapi.io/api/mcp${search}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
}

async function call(
  name: string,
  options: Partial<McpHttpOptions> = {},
  search = '',
): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const res = await handleUpapiMcpRequest(callTool(name, search), { caller, ...options });
  const body = JSON.parse(await res.text()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return body.result;
}

describe('a tools/call for a tool this request does not serve', () => {
  it('is reported once with the requested name and the served mode, and still answers NOT_FOUND', async () => {
    const onUnknownTool = vi.fn();

    const result = await call('invoices_list', { onUnknownTool });

    expect(onUnknownTool).toHaveBeenCalledTimes(1);
    expect(onUnknownTool).toHaveBeenCalledWith('invoices_list', 'compact');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('NOT_FOUND: unknown tool "invoices_list"');
  });

  it('reports the mode the request asked for', async () => {
    const onUnknownTool = vi.fn();

    await call('execute_typescript', { onUnknownTool }, '?tools=full');

    expect(onUnknownTool).toHaveBeenCalledWith('execute_typescript', 'full');
  });

  it('answers exactly the same NOT_FOUND when the hook throws', async () => {
    const result = await call('invoices_list', {
      onUnknownTool: () => {
        throw new Error('telemetry down');
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('NOT_FOUND: unknown tool "invoices_list"');
  });

  it('answers NOT_FOUND unchanged when the host passes no hook', async () => {
    const result = await call('invoices_list');

    expect(result.content[0]?.text).toBe('NOT_FOUND: unknown tool "invoices_list"');
  });
});

describe('a tools/call for a served tool', () => {
  it('is not reported', async () => {
    const onUnknownTool = vi.fn();

    const result = await call('search_ops', { onUnknownTool });

    expect(result.isError).not.toBe(true);
    expect(onUnknownTool).not.toHaveBeenCalled();
  });

  it('is not reported when it is withheld for lack of authorization — that is FORBIDDEN, not unknown', async () => {
    const onUnknownTool = vi.fn();

    const result = await call('call_op', { onUnknownTool, canExecute: false });

    expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
    expect(onUnknownTool).not.toHaveBeenCalled();
  });
});

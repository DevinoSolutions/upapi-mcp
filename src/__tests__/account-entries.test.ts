import { describe, expect, it, vi } from 'vitest';
import { handleUpapiMcpRequest } from '../http.js';
import { ACCOUNT_TOOL_DEFS, createAccountToolEntries } from '../account-tools.js';
import { selectListedTools } from '../table.js';
import { createUpapiToolSpecs } from '../tools.js';
import { DenialError } from '../denial.js';
import { createGatewayAccountCaller } from '../caller.js';

const caller = async () => ({});
const rpc = (body: unknown) =>
  new Request('https://app.upapi.io/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
async function run(
  method: string,
  params: unknown,
  opts: Parameters<typeof handleUpapiMcpRequest>[1],
) {
  const res = await handleUpapiMcpRequest(rpc({ jsonrpc: '2.0', id: 1, method, params }), opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 2026-10-27 test-only JSON-RPC envelope
  return (JSON.parse(await res.text()) as { result: any }).result;
}

describe('account tools on the wire', () => {
  it('are listed in every mode next to the operation tools', () => {
    const specs = createUpapiToolSpecs({ caller });
    const account = createAccountToolEntries({ caller: vi.fn() });
    for (const mode of ['compact', 'directory', 'claude', 'full'] as const) {
      const names = selectListedTools(specs, {
        mode,
        canExecute: true,
        canSearch: true,
        accountTools: account,
      }).map((t) => t.name);
      for (const d of ACCOUNT_TOOL_DEFS) expect(names, `${mode}:${d.name}`).toContain(d.name);
    }
  });
  it('stay listed when the connection cannot run operations', () => {
    const specs = createUpapiToolSpecs({ caller });
    const names = selectListedTools(specs, {
      mode: 'compact',
      canExecute: false,
      canSearch: false,
      accountTools: createAccountToolEntries({ caller: vi.fn() }),
    }).map((t) => t.name);
    expect(names).toContain('billing_status');
    expect(names).not.toContain('call_op');
  });
  it('tools/call dispatches to the AccountCaller and returns JSON text', async () => {
    const accountCaller = vi.fn(async () => ({ plan: 'Pro' }));
    const result = await run(
      'tools/call',
      { name: 'billing_status', arguments: {} },
      { caller, accountCaller },
    );
    expect(accountCaller).toHaveBeenCalledWith('billing_status', {});
    expect(JSON.parse(result.content[0].text)).toEqual({ plan: 'Pro' });
  });
  it('a DenialError becomes the envelope with isError', async () => {
    const accountCaller = async () => {
      throw new DenialError({
        code: 'CONFIRMATION_REQUIRED',
        message: 'Confirm.',
        next: { tool: 'delete_account', args: { confirmToken: 't' } },
      });
    };
    const result = await run(
      'tools/call',
      { name: 'delete_account', arguments: { workspaceName: 'x' } },
      { caller, accountCaller },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      next: { tool: 'delete_account' },
    });
  });
  it('checks tiers before calling out when the host passes them', async () => {
    const accountCaller = vi.fn();
    const result = await run(
      'tools/call',
      { name: 'upgrade_plan', arguments: { plan: 'pro' } },
      { caller, accountCaller, tiers: new Set(['read']) },
    );
    expect(accountCaller).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      code: 'SCOPE_MISSING',
      next: { tool: 'request_scopes', args: { tiers: ['billing'] } },
    });
  });
  it('without an accountCaller no account tool exists (old hosts are unaffected)', async () => {
    const result = await run('tools/list', {}, { caller });
    expect(result.tools.map((t: { name: string }) => t.name)).not.toContain('billing_status');
  });
  it('the compact table WITH account tools stays under the 32 KiB context budget', async () => {
    const result = await run('tools/list', {}, { caller, accountCaller: vi.fn() });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(32 * 1024);
  });
});

describe('createGatewayAccountCaller', () => {
  it('returns the body on 200 and posts the key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    const call = createGatewayAccountCaller({ apiKey: 'upapi_k', fetchImpl });
    await expect(call('billing_status', {})).resolves.toEqual({ ok: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.upapi.io/account-tools/billing_status');
    expect(new Headers(init.headers).get('x-api-key')).toBe('upapi_k');
  });
  it('surfaces a 403 SCOPE_MISSING body as the envelope', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 'SCOPE_MISSING',
            message: 'no',
            next: { tool: 'request_scopes' },
          }),
          { status: 403 },
        ),
    );
    const call = createGatewayAccountCaller({ apiKey: 'k', fetchImpl });
    await expect(call('upgrade_plan', {})).rejects.toMatchObject({
      denial: { code: 'SCOPE_MISSING', next: { tool: 'request_scopes' } },
    });
  });
});

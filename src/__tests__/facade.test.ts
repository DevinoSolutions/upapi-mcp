import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS } from '@upapi/sdk';
import { createUpapiToolSpecs, isDirectoryListedOperation, type Caller } from '../tools.js';
import { ALWAYS_ON_SLUGS, CALL_OP_TOOL_NAME, SEARCH_OPS_TOOL_NAME } from '../facade.js';
import { handleUpapiMcpRequest, resolveToolMode } from '../http.js';

/**
 * The compact facade — the surface a hosted MCP connection actually gets.
 *
 * Two properties carry the whole feature and are asserted here rather than
 * described: the table stays small enough to re-send every turn, and it can
 * reach EXACTLY what the per-op table could reach — no more (a withheld
 * operation stays withheld when named through `call_op`) and no less (an
 * unlisted-but-served operation is still callable).
 */

const noopCaller: Caller = vi.fn(async () => ({ ok: true }));

const LISTED = OPERATIONS.filter(isDirectoryListedOperation);
const WITHHELD = OPERATIONS.filter((op) => !isDirectoryListedOperation(op));

function rpc(body: unknown, search = ''): Request {
  return new Request(`https://app.upapi.io/api/mcp${search}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function listTools(
  search = '',
  options: Partial<Parameters<typeof handleUpapiMcpRequest>[1]> = {},
): Promise<{ raw: string; tools: Array<{ name: string; annotations?: Record<string, unknown> }> }> {
  const res = await handleUpapiMcpRequest(
    rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, search),
    {
      caller: noopCaller,
      ...options,
    },
  );
  const raw = await res.text();
  const parsed = JSON.parse(raw) as { result: { tools: Array<{ name: string }> } };
  return { raw, tools: parsed.result.tools };
}

async function callTool(
  name: string,
  args: unknown,
  options: Partial<Parameters<typeof handleUpapiMcpRequest>[1]> = {},
): Promise<{ isError?: boolean; content: Array<{ text: string }> }> {
  const res = await handleUpapiMcpRequest(
    rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    { caller: noopCaller, ...options },
  );
  const parsed = JSON.parse(await res.text()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return parsed.result;
}

describe('the default table is compact', () => {
  it('serves the two meta-tools plus the always-on operations, not the catalog', async () => {
    const { tools } = await listTools();
    const names = tools.map((t) => t.name);

    expect(names[0]).toBe(SEARCH_OPS_TOOL_NAME);
    expect(names).toContain(CALL_OP_TOOL_NAME);
    expect(names).toHaveLength(2 + ALWAYS_ON_SLUGS.length);
    expect(names.length).toBeLessThan(LISTED.length);
  });

  it('keeps the whole tools/list response under the context budget', async () => {
    // The reason this feature exists. The full table is tens of kilobytes of
    // JSON Schema re-sent on every turn; the compact one has to stay small
    // enough that nobody has to think about it. 8 KB is the ceiling — if a new
    // always-on operation pushes past it, drop one rather than raising this.
    const { raw } = await listTools();
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(8 * 1024);
  });

  it('is dramatically smaller than the full table it replaces', async () => {
    const compact = await listTools();
    const full = await listTools('?tools=full');
    expect(Buffer.byteLength(compact.raw)).toBeLessThan(Buffer.byteLength(full.raw) / 3);
  });

  it('only makes always-on an operation this surface already serves', () => {
    // The facade must never widen the table. `reddit-search-posts.get` is the
    // standing temptation here — high demand, and withheld by category.
    for (const slug of ALWAYS_ON_SLUGS) {
      expect(LISTED.map((op) => op.slug)).toContain(slug);
    }
    for (const op of WITHHELD) {
      expect(ALWAYS_ON_SLUGS).not.toContain(op.slug);
    }
  });
});

describe('?tools=full serves the original per-op table', () => {
  it('lists one tool per directory-listed operation and no meta-tools', async () => {
    const { tools } = await listTools('?tools=full');
    expect(tools.map((t) => t.name).sort()).toEqual(LISTED.map((op) => op.operationId).sort());
  });

  it('reads the mode off the request URL, defaulting to compact', () => {
    expect(resolveToolMode(rpc({}, '?tools=full'))).toBe('full');
    expect(resolveToolMode(rpc({}))).toBe('compact');
    // A typo must not take a working connection down.
    expect(resolveToolMode(rpc({}, '?tools=everything'))).toBe('compact');
  });

  it('lets the host override the query parameter outright', async () => {
    const { tools } = await listTools('?tools=full', { mode: 'compact' });
    expect(tools.map((t) => t.name)).toContain(SEARCH_OPS_TOOL_NAME);
    expect(tools).toHaveLength(2 + ALWAYS_ON_SLUGS.length);
  });
});

describe('search_ops discovers exactly what this connection may run', () => {
  async function search(args: unknown, options: Parameters<typeof callTool>[2] = {}) {
    const result = await callTool(SEARCH_OPS_TOOL_NAME, args, options);
    return JSON.parse(result.content[0]!.text) as {
      matches: Array<{ slug: string; category: string; unitWeight: number; parameters: unknown[] }>;
      total: number;
      returned: number;
      categories: string[];
    };
  }

  it('finds an operation by an intent word rather than by its slug', async () => {
    const found = await search({ query: 'repository stars' });
    expect(found.matches.map((m) => m.slug)).toContain('github-repo.get');
  });

  it('returns the cost and the parameters an agent needs to call it', async () => {
    const found = await search({ query: 'github-repo.get' });
    const match = found.matches[0]!;
    expect(match.slug).toBe('github-repo.get');
    expect(match.unitWeight).toBeGreaterThanOrEqual(1);
    expect(match.parameters.length).toBeGreaterThan(0);
  });

  it('browses the whole served catalog on an empty query', async () => {
    const found = await search({ query: '', limit: 50 });
    expect(found.total).toBe(LISTED.length);
  });

  it('never surfaces a withheld operation, however it is queried', async () => {
    // The directory exclusion has to survive discovery, or the facade becomes
    // the index for the very categories the surface withholds.
    const found = await search({ query: '', limit: 50 });
    const slugs = found.matches.map((m) => m.slug);
    for (const op of WITHHELD) {
      expect(slugs).not.toContain(op.slug);
    }
  });

  it('inherits a host filter, so it can never out-list the tool table', async () => {
    const only = LISTED[0]!;
    const found = await search({ query: '', limit: 50 }, { filter: (op) => op.slug === only.slug });
    expect(found.matches.map((m) => m.slug)).toEqual([only.slug]);
  });

  it('honors the category filter and the limit', async () => {
    const found = await search({ query: '', category: LISTED[0]!.category, limit: 2 });
    expect(found.returned).toBeLessThanOrEqual(2);
    for (const match of found.matches) expect(match.category).toBe(LISTED[0]!.category);
  });

  it('answers an unmatched query with an empty list and a way forward, not an error', async () => {
    const result = await callTool(SEARCH_OPS_TOOL_NAME, { query: 'zzzzz-nothing-matches-this' });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text) as { matches: unknown[]; next: string };
    expect(payload.matches).toHaveLength(0);
    expect(payload.next).toContain('broader');
  });

  it('requires every term to match, so a search stays a search', async () => {
    const both = await search({ query: 'github zzzzznope', limit: 50 });
    expect(both.total).toBe(0);
  });
});

describe('call_op is the per-op path, reached by slug', () => {
  it('executes through the same caller with the same slug and input', async () => {
    const caller = vi.fn(async () => ({ stars: 1 }));
    const target = LISTED[0]!;
    const result = await callTool(
      CALL_OP_TOOL_NAME,
      { slug: target.slug, input: { a: 1 } },
      { caller },
    );
    expect(caller).toHaveBeenCalledWith(target.slug, { a: 1 });
    expect(result.isError).toBeUndefined();
  });

  it('substitutes an empty input when the agent sends none', async () => {
    const caller = vi.fn(async () => ({}));
    const target = LISTED[0]!;
    await callTool(CALL_OP_TOOL_NAME, { slug: target.slug }, { caller });
    expect(caller).toHaveBeenCalledWith(target.slug, {});
  });

  it('refuses a withheld operation with the same NOT_FOUND the per-op path gives', async () => {
    const caller = vi.fn(async () => ({ leaked: true }));
    const hidden = WITHHELD[0]!;

    const viaFacade = await callTool(CALL_OP_TOOL_NAME, { slug: hidden.slug }, { caller });
    const viaName = await callTool(hidden.operationId, {}, { caller });

    expect(caller).not.toHaveBeenCalled();
    expect(viaFacade.isError).toBe(true);
    expect(viaFacade.content[0]?.text).toContain('NOT_FOUND');
    expect(viaName.content[0]?.text).toContain('NOT_FOUND');
  });

  it('refuses an unknown slug without saying anything about why', async () => {
    const result = await callTool(CALL_OP_TOOL_NAME, { slug: 'no-such-op.get' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('NOT_FOUND: unknown tool "no-such-op.get"');
  });

  it("surfaces an operation failure as a tool error carrying upAPI's code", async () => {
    const caller = vi.fn(async () => {
      throw Object.assign(new Error('Rate limit exceeded'), {
        code: 'RATE_LIMITED',
        status: 429,
        retryAfterSeconds: 60,
      });
    });
    const result = await callTool(CALL_OP_TOOL_NAME, { slug: LISTED[0]!.slug }, { caller });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('RATE_LIMITED');
    expect(result.content[0]?.text).toContain('Retry after 60 seconds');
  });

  it('still runs a served operation that compact mode does not list', async () => {
    // Compact is a context-budget decision, not an access decision: the access
    // decision is the served set, and it is identical in both modes.
    const caller = vi.fn(async () => ({ ok: true }));
    const unlisted = LISTED.find((op) => !ALWAYS_ON_SLUGS.includes(op.slug))!;
    const result = await callTool(unlisted.operationId, {}, { caller });
    expect(result.isError).toBeUndefined();
    expect(caller).toHaveBeenCalledWith(unlisted.slug, {});
  });
});

describe('annotations state what the meta-tools do', () => {
  it('marks search_ops read-only and closed-world', async () => {
    const { tools } = await listTools();
    const search = tools.find((t) => t.name === SEARCH_OPS_TOOL_NAME);
    expect(search?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('never claims call_op is read-only or idempotent', async () => {
    // It dispatches to whatever the catalog offers; annotating it from today's
    // contents would be a promise about data that no diff would ever revisit.
    const { tools } = await listTools();
    const call = tools.find((t) => t.name === CALL_OP_TOOL_NAME);
    expect(call?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('holds the one claim call_op makes about contents: nothing reachable is destructive', () => {
    // `destructiveHint: false` on the dispatcher is only honest while this is
    // true of every operation it can reach.
    for (const spec of createUpapiToolSpecs({
      caller: noopCaller,
      filter: isDirectoryListedOperation,
    })) {
      expect(spec.annotations.destructiveHint, spec.slug).toBe(false);
    }
  });
});

describe('authorization narrows the table, in both modes', () => {
  it('shows a caller without execute rights only search_ops', async () => {
    const compact = await listTools('', { canExecute: false });
    expect(compact.tools.map((t) => t.name)).toEqual([SEARCH_OPS_TOOL_NAME]);

    // Full mode too: listing per-op tools a caller may not run would be a lie
    // with a tool call's worth of latency attached to discovering it.
    const full = await listTools('?tools=full', { canExecute: false });
    expect(full.tools.map((t) => t.name)).toEqual([SEARCH_OPS_TOOL_NAME]);
  });

  it('refuses execution by any route when execute rights are absent', async () => {
    const caller = vi.fn(async () => ({ leaked: true }));
    const target = LISTED[0]!;
    for (const attempt of [
      callTool(CALL_OP_TOOL_NAME, { slug: target.slug }, { caller, canExecute: false }),
      callTool(target.operationId, {}, { caller, canExecute: false }),
    ]) {
      const result = await attempt;
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('FORBIDDEN');
    }
    expect(caller).not.toHaveBeenCalled();
  });

  it('drops search_ops when catalog reads are not granted', async () => {
    const { tools } = await listTools('', { canSearch: false });
    expect(tools.map((t) => t.name)).not.toContain(SEARCH_OPS_TOOL_NAME);
    const result = await callTool(SEARCH_OPS_TOOL_NAME, { query: '' }, { canSearch: false });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('FORBIDDEN');
  });

  it('grants both by default, so a host with no scope model is unaffected', async () => {
    const { tools } = await listTools();
    expect(tools.map((t) => t.name)).toContain(SEARCH_OPS_TOOL_NAME);
    expect(tools.map((t) => t.name)).toContain(CALL_OP_TOOL_NAME);
  });
});

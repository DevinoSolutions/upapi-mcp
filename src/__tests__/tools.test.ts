import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS, OPERATION_SLUGS } from '@upapi/sdk';
import {
  createUpapiToolSpecs,
  isDirectoryListedOperation,
  DIRECTORY_EXCLUDED_CATEGORIES,
  OPERATION_ANNOTATIONS,
  type Caller,
} from '../tools.js';
import { formatToolFailure, toToolFailure } from '../errors.js';
import { handleUpapiMcpRequest } from '../http.js';

const noopCaller: Caller = vi.fn(async () => ({ ok: true }));

/** What the hosted endpoint serves, and what it withholds — see DIRECTORY_EXCLUDED_CATEGORIES. */
const LISTED = OPERATIONS.filter(isDirectoryListedOperation);
const WITHHELD = OPERATIONS.filter((op) => !isDirectoryListedOperation(op));

/**
 * Every request here asks for `?tools=full`: this file specifies the PER-OP tool
 * table, which is now what full mode serves. The default (compact) table and the
 * `search_ops`/`call_op` facade have their own file, `facade.test.ts` — including
 * the guarantee that neither mode changes what is reachable.
 */
function rpc(body: unknown): Request {
  return new Request('https://app.upapi.io/api/mcp?tools=full', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
}

async function rpcResult(request: Request, caller = noopCaller): Promise<Record<string, unknown>> {
  const res = await handleUpapiMcpRequest(request, { caller });
  const parsed = JSON.parse(await res.text()) as { result?: Record<string, unknown> };
  return parsed.result ?? {};
}

describe('the tool table covers the catalog', () => {
  it('exposes exactly one tool per public operation', () => {
    const specs = createUpapiToolSpecs({ caller: noopCaller });
    expect(specs).toHaveLength(OPERATIONS.length);
    expect(specs.map((s) => s.name).sort()).toEqual(OPERATIONS.map((o) => o.operationId).sort());
  });

  it('names tools so an MCP client accepts them', () => {
    // MCP tool names are matched literally by clients and models; dots and dashes
    // from the slug would be legal but hostile to reference in a prompt.
    for (const spec of createUpapiToolSpecs({ caller: noopCaller })) {
      expect(spec.name).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it('advertises the operation schema itself, not a rebuilt one', () => {
    // The whole point of the JSON-Schema passthrough: what an agent reads in
    // tools/list is the object the worker's own model produced. Identity, not
    // deep-equality, is the assertion that can never drift.
    for (const spec of createUpapiToolSpecs({ caller: noopCaller })) {
      const op = OPERATIONS.find((o) => o.operationId === spec.name);
      expect(spec.inputSchema).toBe(op?.inputSchema);
    }
  });

  it('advertises a non-empty schema with real parameters for every operation', () => {
    for (const spec of createUpapiToolSpecs({ caller: noopCaller })) {
      const schema = spec.inputSchema as { type?: string; properties?: Record<string, unknown> };
      expect(schema.type).toBe('object');
      expect(Object.keys(schema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('tells the agent what a call costs', () => {
    const spec = createUpapiToolSpecs({ caller: noopCaller }).find((s) => s.unitWeight > 1);
    if (spec) expect(spec.description).toContain(`${spec.unitWeight} units`);
    const cheap = createUpapiToolSpecs({ caller: noopCaller }).find((s) => s.unitWeight === 1);
    expect(cheap?.description).toContain('1 unit');
  });

  it('honors a filter', () => {
    const only = OPERATIONS[0]!.slug;
    const specs = createUpapiToolSpecs({ caller: noopCaller, filter: (op) => op.slug === only });
    expect(specs.map((s) => s.slug)).toEqual([only]);
  });
});

describe('every tool declares how it behaves', () => {
  const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

  it('classifies every catalog operation, and only catalog operations', () => {
    // The table is the gate on a NEW operation reaching agents unreviewed: add
    // one to the catalog and this fails until someone decides what it does. The
    // reverse direction matters too — a stale key is a classification nobody is
    // reading, and it would hide the fact that its operation is now unclassified
    // under some other name.
    expect(Object.keys(OPERATION_ANNOTATIONS).sort()).toEqual([...OPERATION_SLUGS].sort());
  });

  it('carries all four hints, as real booleans, on every tool', () => {
    const specs = createUpapiToolSpecs({ caller: noopCaller });
    expect(specs).toHaveLength(OPERATIONS.length);
    for (const spec of specs) {
      for (const hint of HINTS) {
        expect(typeof spec.annotations[hint], `${spec.slug}.${hint}`).toBe('boolean');
      }
    }
  });

  it('marks every tool openWorldHint — upAPI IS the third-party call surface', () => {
    // The marketplace requirement, pinned: every published operation exists to
    // reach a system upAPI does not own. If an operation is ever added that only
    // reads upAPI's own workspace or key state, this assertion is the place to
    // carve it out deliberately — not `OPERATION_ANNOTATIONS` quietly.
    for (const spec of createUpapiToolSpecs({ caller: noopCaller })) {
      expect(spec.annotations.openWorldHint, spec.slug).toBe(true);
    }
  });

  it('claims read-only ONLY for operations that write nothing upstream', () => {
    // Named exhaustively rather than counted: the failure this guards against is
    // a new operation inheriting `readOnlyHint: true` — the annotation that lets
    // a host run it without asking — because it looked like its neighbours.
    const writers = createUpapiToolSpecs({ caller: noopCaller })
      .filter((spec) => !spec.annotations.readOnlyHint)
      .map((spec) => spec.slug)
      .sort();
    expect(writers).toEqual([
      'audio-transcribe.post',
      'email-read-verification-code.post',
      'email-read-verification-link.post',
      'instagram-check-account.post',
    ]);
  });

  it('never claims a read-only tool is destructive, and marks nothing destructive', () => {
    // No published operation deletes or overwrites anything: the writers above
    // open a mailbox read-write and probe a recovery endpoint respectively.
    for (const spec of createUpapiToolSpecs({ caller: noopCaller })) {
      expect(spec.annotations.destructiveHint, spec.slug).toBe(false);
      if (spec.annotations.readOnlyHint) {
        expect(spec.annotations.idempotentHint, spec.slug).toBe(true);
      }
    }
  });

  it('does not call an account-recovery probe idempotent', () => {
    // Repeats accumulate against Instagram's abuse counters for the queried
    // account — the worker's own 429 branch tells callers to space them.
    const spec = createUpapiToolSpecs({ caller: noopCaller }).find(
      (s) => s.slug === 'instagram-check-account.post',
    );
    expect(spec?.annotations.idempotentHint).toBe(false);
  });
});

describe('execution goes through the injected caller', () => {
  it('passes the slug and input straight through', async () => {
    const caller = vi.fn(async () => ({ temperature: 21 }));
    const spec = createUpapiToolSpecs({ caller })[0]!;
    const result = await spec.call({ q: 'ottawa' });
    expect(caller).toHaveBeenCalledWith(spec.slug, { q: 'ottawa' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('temperature');
  });

  it('substitutes an empty object when the client sends no arguments', async () => {
    const caller = vi.fn(async () => ({}));
    const spec = createUpapiToolSpecs({ caller })[0]!;
    await spec.call(undefined);
    expect(caller).toHaveBeenCalledWith(spec.slug, {});
  });

  it('reports a failure as a tool error, never as a thrown protocol error', async () => {
    const caller = vi.fn(async () => {
      throw Object.assign(new Error('Rate limit exceeded: 10 requests/minute'), {
        code: 'RATE_LIMITED',
        status: 429,
        retryAfterSeconds: 60,
      });
    });
    const spec = createUpapiToolSpecs({ caller })[0]!;
    const result = await spec.call({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('RATE_LIMITED');
    // An agent told only "rate limited" retries immediately and burns the next
    // window too, so the wait has to be in the text it reads.
    expect(result.content[0]?.text).toContain('Retry after 60 seconds');
  });

  it('degrades an unrecognizable throw to UNKNOWN rather than losing it', () => {
    const failure = toToolFailure(new Error('boom'));
    expect(failure.code).toBe('UNKNOWN');
    expect(formatToolFailure('x.get', failure)).toContain('boom');
  });
});

describe('streamable HTTP transport', () => {
  it('lists every listed tool with its real schema over the wire', async () => {
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const tools = result['tools'] as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools).toHaveLength(LISTED.length);

    const first = LISTED[0]!;
    const served = tools.find((t) => t.name === first.operationId);
    const source = first.inputSchema as { properties?: object; required?: string[] };
    expect(served?.inputSchema['properties']).toEqual(source.properties);
    expect(served?.inputSchema['required']).toEqual(source.required);
  });

  it('puts every tool annotation on the wire', async () => {
    // The hints are only worth declaring if a client can read them, so this
    // asserts against the serialized JSON-RPC response rather than the specs.
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' }));
    const tools = result['tools'] as {
      name: string;
      annotations?: Record<string, unknown>;
    }[];
    expect(tools).toHaveLength(LISTED.length);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(tool.annotations?.['openWorldHint'], tool.name).toBe(true);
    }
  });

  it('advertises exactly one listed writer — everything else is a safe read', async () => {
    // The mailbox/recovery writers live in the excluded categories, so they never
    // reach this table. `audio-transcribe.post` is the ONE reviewed exception: it
    // is listed (category Tools) and submits a GPU job upstream, so it honestly
    // reports readOnly:false + idempotent:false (a retry mints a fresh job id and
    // spends GPU budget twice — see GPU_JOB_SUBMIT in tools.ts). Any OTHER writer
    // landing in a listed category still has to be looked at before a connector
    // host is told it may run it unattended — extend the carve-out deliberately.
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }));
    const tools = result['tools'] as { name: string; annotations?: Record<string, unknown> }[];
    const REVIEWED_WRITERS = new Set(['audio_transcribe_post']);
    for (const tool of tools) {
      expect(tool.annotations?.['destructiveHint'], tool.name).toBe(false);
      if (REVIEWED_WRITERS.has(tool.name)) {
        expect(tool.annotations?.['readOnlyHint'], tool.name).toBe(false);
        expect(tool.annotations?.['idempotentHint'], tool.name).toBe(false);
      } else {
        expect(tool.annotations?.['readOnlyHint'], tool.name).toBe(true);
        expect(tool.annotations?.['idempotentHint'], tool.name).toBe(true);
      }
    }
    expect(tools.some((t) => REVIEWED_WRITERS.has(t.name))).toBe(true);
  });

  it('executes a tool call through the caller', async () => {
    const caller = vi.fn(async () => ({ hello: 'world' }));
    const first = LISTED[0]!;
    const result = await rpcResult(
      rpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: first.operationId, arguments: { a: 1 } },
      }),
      caller,
    );
    expect(caller).toHaveBeenCalledWith(first.slug, { a: 1 });
    const content = result['content'] as { text: string }[];
    expect(content[0]?.text).toContain('world');
  });

  it('answers an unknown tool with an error result, not a crash', async () => {
    const result = await rpcResult(
      rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nope', arguments: {} } }),
    );
    expect(result['isError']).toBe(true);
  });

  it('hides operations the caller may not use', async () => {
    const only = LISTED[0]!;
    const res = await handleUpapiMcpRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }), {
      caller: noopCaller,
      filter: (op) => op.slug === only.slug,
    });
    const parsed = JSON.parse(await res.text()) as { result: { tools: { name: string }[] } };
    expect(parsed.result.tools.map((t) => t.name)).toEqual([only.operationId]);
  });
});

/**
 * The hosted endpoint is what an AI directory advertises to anyone who clicks
 * "connect", so its tool table is a narrower thing than "the catalog" and has to
 * stay that way without anyone remembering to check. These specs are the memory:
 * a new Social Media operation added to the catalog is excluded automatically,
 * and if that ever stops being true this file fails rather than a reviewer
 * finding an Instagram scraper in a listing.
 */
describe('the hosted surface is scoped to what a directory may advertise', () => {
  it('withholds exactly the Social Media and Utility operations', () => {
    expect(WITHHELD.length).toBeGreaterThan(0);
    for (const op of WITHHELD) {
      expect(DIRECTORY_EXCLUDED_CATEGORIES).toContain(op.category);
    }
    for (const op of LISTED) {
      expect(DIRECTORY_EXCLUDED_CATEGORIES).not.toContain(op.category);
    }
  });

  it('serves the listed operations and no others over tools/list', async () => {
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' }));
    const names = (result['tools'] as { name: string }[]).map((t) => t.name).sort();

    expect(names).toEqual(LISTED.map((op) => op.operationId).sort());
    for (const op of WITHHELD) {
      expect(names).not.toContain(op.operationId);
    }
  });

  it('refuses to CALL a withheld operation, not merely to advertise it', async () => {
    // Hiding a tool from tools/list while still executing it on request would be
    // no exclusion at all — an agent only has to guess the name.
    const caller = vi.fn(async () => ({ leaked: true }));
    const hidden = WITHHELD[0]!;
    const result = await rpcResult(
      rpc({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: hidden.operationId, arguments: {} },
      }),
      caller,
    );

    expect(result['isError']).toBe(true);
    expect(caller).not.toHaveBeenCalled();
  });

  it('lets a host narrow the surface further but never widen it', async () => {
    const hidden = WITHHELD[0]!;
    const res = await handleUpapiMcpRequest(rpc({ jsonrpc: '2.0', id: 12, method: 'tools/list' }), {
      caller: noopCaller,
      // A host asking for a withheld operation by name still does not get it.
      filter: (op) => op.slug === hidden.slug,
    });
    const parsed = JSON.parse(await res.text()) as { result: { tools: { name: string }[] } };
    expect(parsed.result.tools).toHaveLength(0);
  });

  it('leaves the unfiltered tool table, the one the stdio server uses, on the full catalog', () => {
    // The exclusion is about what a directory advertises, not about what upAPI
    // can do: a developer who installs `upapi-mcp` with their own key still gets
    // every operation, exactly as the REST gateway does. That server is built by
    // createUpapiTools(), a 1:1 wrap of these specs with no filter of its own —
    // asserted here rather than through ../mastra.js, which this file stays free
    // of on purpose (importing it would pull @mastra/core into the http tests).
    const full = createUpapiToolSpecs({ caller: noopCaller });
    expect(full).toHaveLength(OPERATIONS.length);
    for (const op of WITHHELD) {
      expect(full.map((spec) => spec.slug)).toContain(op.slug);
    }
  });

  it('pins the counts the marketplace listing copy quotes', () => {
    // If a catalog change moves these numbers, any listing/submission text
    // quoting them needs the same edit — hence a hard assertion rather than a
    // derived one. 2026-08-13: 26→33 listed (the 7 new Tools ops: screenshot,
    // html-to-pdf, fetch-markdown, pdf-extract-text, image-ocr and the
    // audio-transcribe pair); withheld unchanged at 24.
    expect(LISTED).toHaveLength(33);
    expect(WITHHELD).toHaveLength(24);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS, OPERATION_SLUGS } from '@upapi/sdk';
import { createUpapiToolSpecs, OPERATION_ANNOTATIONS, type Caller } from '../tools.js';
import { CALL_OP_TOOL_NAME } from '../facade.js';
import { formatToolFailure, toToolFailure } from '../errors.js';
import { handleUpapiMcpRequest } from '../http.js';

const noopCaller: Caller = vi.fn(async () => ({ ok: true }));

/** The seeded catalog: every row, public and internal (`publishTargets: []`). */
const SEED_PATH = fileURLToPath(
  new URL('../../../../apps/web/scripts/operations.seed.json', import.meta.url),
);

interface SeedRow {
  slug: string;
  publishTargets: string[];
}

function readSeedRows(): SeedRow[] {
  return (JSON.parse(readFileSync(SEED_PATH, 'utf8')) as { operations: SeedRow[] }).operations;
}

/**
 * Every operation that is NOT read-only, named exhaustively. Since 2026-09-26
 * the hosted endpoint lists every public operation, so each of these reaches a
 * connector host's tool table and its hints are the only thing that tells the
 * host not to run it unattended.
 */
const WRITER_SLUGS: readonly string[] = [
  'audio-transcribe.post',
  'email-read-verification-code-graph.post',
  'email-read-verification-code.post',
  'email-read-verification-link.post',
  'instagram-check-account.post',
  // Publishes a Reddit comment under a person's name — see PUBLIC_POST_WRITE.
  'reddit-oauth-post-comment.post',
  // Opening a Wellfound recruiter thread. It is the only writer here whose side
  // effect is unmeasured rather than known: a conversation carries a
  // server-side `unread` flag, this is the query the UI fires when a human
  // opens a thread, and settling whether that clears it needs a live account
  // nobody logged into for the port. See INBOX_THREAD_OPEN in tools.ts.
  'wellfound-conversation-detail.post',
];

/**
 * Operations the hosted endpoint withheld until 2026-09-26, pinned by NAME so
 * a future gate cannot quietly take them back off: the owner decided the hosted
 * MCP hides nothing. One per former exclusion — the Social Media and Utility
 * categories and the two slug-level exclusions.
 */
const FORMERLY_WITHHELD_SLUGS: readonly string[] = [
  'reddit-oauth-post-comment.post',
  'email-read-verification-code.post',
  'linkedin-profile-search.post',
  'github-user-emails.get',
];

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

/**
 * Operations that reach NOTHING outside the process, so `openWorldHint` is false.
 *
 * `text-analyze.post`, the Rust worker's pure-compute endpoint, plus (2026-09-22)
 * `email-generate-address.post`, which builds a persona string from an in-process
 * random draw and verifies/creates nothing anywhere. A list rather than a special
 * case in each assertion, so adding one is a single reviewed edit — and so the
 * two assertions below can never disagree about which operations are exempt.
 */
const CLOSED_WORLD_SLUGS: readonly string[] = ['text-analyze.post', 'email-generate-address.post'];

/** The same set as MCP tool names (`operationId`: slug with `.`/`-` → `_`). */
const CLOSED_WORLD_TOOL_NAMES: readonly string[] = OPERATIONS.filter((op) =>
  CLOSED_WORLD_SLUGS.includes(op.slug),
).map((op) => op.operationId);

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
      // 64 is the MCP/LLM-provider tool-name limit; a longer one is rejected by the host.
      expect(spec.name.length, spec.name).toBeLessThanOrEqual(64);
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

  it('marks every tool openWorldHint, except the one that touches no network', () => {
    // The marketplace requirement, pinned: a published operation exists to reach a
    // system upAPI does not own. The carve-out this comment always invited is now
    // taken, ONCE and by name: `text-analyze.post` is pure compute (counts + a
    // SHA-256 over a caller-supplied string, in the Rust worker) and reaches
    // nothing at all, so claiming openWorld would tell a host to be careful about
    // a call that cannot leave the process. Naming it here rather than letting
    // `OPERATION_ANNOTATIONS` say it quietly is the whole point of the assertion.
    for (const spec of createUpapiToolSpecs({ caller: noopCaller })) {
      expect(spec.annotations.openWorldHint, spec.slug).toBe(
        !CLOSED_WORLD_SLUGS.includes(spec.slug),
      );
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
    expect(writers).toEqual([...WRITER_SLUGS].sort());
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
  it('lists every operation with its real schema over the wire', async () => {
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    const tools = result['tools'] as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools).toHaveLength(OPERATIONS.length);

    const first = OPERATIONS[0]!;
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
    expect(tools).toHaveLength(OPERATIONS.length);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      expect(tool.annotations?.['openWorldHint'], tool.name).toBe(
        !CLOSED_WORLD_TOOL_NAMES.includes(tool.name),
      );
    }
  });

  it('advertises every reviewed writer as a writer — everything else is a safe read', async () => {
    // With every public operation listed (2026-09-26), the mailbox, recovery,
    // inbox and comment writers reach this table alongside `audio-transcribe.post`,
    // so a connector host sees each of them as readOnly:false. Asserted on the
    // SERIALIZED response: a hint that is right in the spec and lost on the wire
    // would let a host run a public comment unattended.
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }));
    const tools = result['tools'] as { name: string; annotations?: Record<string, unknown> }[];
    const writerNames = new Set(
      OPERATIONS.filter((op) => WRITER_SLUGS.includes(op.slug)).map((op) => op.operationId),
    );
    expect(writerNames.size).toBe(WRITER_SLUGS.length);
    for (const tool of tools) {
      expect(tool.annotations?.['destructiveHint'], tool.name).toBe(false);
      expect(tool.annotations?.['readOnlyHint'], tool.name).toBe(!writerNames.has(tool.name));
      if (!writerNames.has(tool.name)) {
        expect(tool.annotations?.['idempotentHint'], tool.name).toBe(true);
      }
    }
    expect(tools.filter((t) => writerNames.has(t.name))).toHaveLength(WRITER_SLUGS.length);
  });

  it('executes a tool call through the caller', async () => {
    const caller = vi.fn(async () => ({ hello: 'world' }));
    const first = OPERATIONS[0]!;
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
    const only = OPERATIONS[0]!;
    const res = await handleUpapiMcpRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' }), {
      caller: noopCaller,
      filter: (op) => op.slug === only.slug,
    });
    const parsed = JSON.parse(await res.text()) as { result: { tools: { name: string }[] } };
    expect(parsed.result.tools.map((t) => t.name)).toEqual([only.operationId]);
  });
});

/**
 * The hosted endpoint lists every public operation. Until 2026-09-26 it withheld
 * the Social Media and Utility categories plus two slugs; the owner lifted that
 * gate ("we shouldn't hide anything that helps for SEO"), so these specs pin the
 * opposite of what they used to: nothing in the catalog is missing from the
 * hosted `full` table, and nothing named there is refused at dispatch.
 */
describe('the hosted surface lists every public operation', () => {
  it('serves every catalog operation over tools/list, and nothing else', async () => {
    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 10, method: 'tools/list' }));
    const names = (result['tools'] as { name: string }[]).map((t) => t.name).sort();

    expect(names).toEqual(OPERATIONS.map((op) => op.operationId).sort());
  });

  it('lists the operations the old directory gate withheld, by name', async () => {
    const bySlug = new Map(OPERATIONS.map((op) => [op.slug, op]));
    // The pin only means something if it still spans both former categories.
    const categories = FORMERLY_WITHHELD_SLUGS.map((slug) => bySlug.get(slug)?.category);
    expect(categories).toContain('Social Media');
    expect(categories).toContain('Utility');

    const result = await rpcResult(rpc({ jsonrpc: '2.0', id: 11, method: 'tools/list' }));
    const names = (result['tools'] as { name: string }[]).map((t) => t.name);
    for (const slug of FORMERLY_WITHHELD_SLUGS) {
      expect(names, slug).toContain(bySlug.get(slug)?.operationId);
    }
  });

  it('executes a formerly withheld operation through the caller', async () => {
    // Listing is not enough: dispatch has to reach it too, or the tool would be
    // advertised and then refused.
    const caller = vi.fn(async () => ({ ok: true }));
    const op = OPERATIONS.find((o) => o.slug === 'linkedin-profile-search.post')!;
    const result = await rpcResult(
      rpc({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: op.operationId, arguments: {} },
      }),
      caller,
    );

    expect(result['isError']).toBeUndefined();
    expect(caller).toHaveBeenCalledWith(op.slug, {});
  });

  it('matches the unfiltered specs the stdio server serves', () => {
    // One registry, two transports: the hosted endpoint no longer differs from
    // what `upapi-mcp` serves a developer with their own key.
    expect(createUpapiToolSpecs({ caller: noopCaller })).toHaveLength(OPERATIONS.length);
  });

  it('serves exactly the public rows of the seeded catalog', () => {
    // Derived, not typed: a hand-kept count went stale the day an op was
    // published or made internal while this was in review. The seed carries
    // every row, so only those with a publish target belong on the surface.
    const seed = readSeedRows();
    const publicSlugs = seed
      .filter((row) => row.publishTargets.includes('upapi'))
      .map((row) => row.slug)
      .sort();
    expect(OPERATIONS.map((op) => op.slug).sort()).toEqual(publicSlugs);
  });

  it('never lists or dispatches an internal operation (empty publishTargets)', async () => {
    // `facebook-post-comment.post` is the named example: a write on a third
    // party's account, internal since #302. Hiding nothing PUBLIC must not widen
    // into exposing what was never published.
    const seed = readSeedRows();
    const internal = seed
      .filter((row) => !row.publishTargets.includes('upapi'))
      .map((row) => row.slug);
    expect(internal).toContain('facebook-post-comment.post');

    const publicNames = new Set(OPERATIONS.map((op) => op.operationId));
    for (const mode of ['full', 'directory']) {
      const list = await handleUpapiMcpRequest(
        new Request(`https://app.upapi.io/api/mcp?tools=${mode}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/list' }),
        }),
        { caller: noopCaller },
      );
      const listed = (JSON.parse(await list.text()) as { result: { tools: { name: string }[] } })
        .result.tools;
      // Nothing listed is outside the public catalog, so no internal op is listed.
      for (const tool of listed)
        expect(publicNames.has(tool.name), `${mode}: ${tool.name}`).toBe(true);
      expect(listed.map((tool) => tool.name).join(' ')).not.toMatch(/facebook/i);
    }

    // Dispatch. The tool table is keyed by operationId (slug with `.`/`-` -> `_`),
    // so ask for the internal op BY THAT NAME, and as `call_op {slug}` in compact
    // mode. A positive control proves the name format reaches a real public
    // writer, so a refusal below is about the op, not about a mistyped name.
    const post = (mode: string, params: unknown, caller: Caller) =>
      rpcResult(
        new Request(`https://app.upapi.io/api/mcp?tools=${mode}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params }),
        }),
        caller,
      );
    const control = vi.fn(async () => ({ ok: true }));
    const controlSlug = 'reddit-oauth-post-comment.post';
    const controlResult = await post(
      'full',
      { name: controlSlug.replace(/[.-]/g, '_'), arguments: {} },
      control,
    );
    expect(controlResult['isError']).toBeUndefined();
    expect(control).toHaveBeenCalledWith(controlSlug, {});

    const caller = vi.fn(async () => ({ ok: true }));
    for (const slug of internal) {
      const name = slug.replace(/[.-]/g, '_');
      for (const mode of ['full', 'directory']) {
        const result = await post(mode, { name, arguments: {} }, caller);
        expect(result['isError'], `${mode}: ${name}`).toBe(true);
      }
      const viaFacade = await post(
        'compact',
        { name: CALL_OP_TOOL_NAME, arguments: { slug } },
        caller,
      );
      expect(viaFacade['isError'], `compact call_op: ${slug}`).toBe(true);
    }
    expect(caller).not.toHaveBeenCalled();
  });
});

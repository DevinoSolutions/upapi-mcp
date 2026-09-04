import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS } from '@upapi/sdk';
import { createUpapiToolSpecs, isDirectoryListedOperation, type Caller } from '../tools.js';
import { CALL_OP_TOOL_NAME, SEARCH_OPS_TOOL_NAME } from '../facade.js';
import { createDirectoryEntries, DIRECTORY_FLAGSHIP_SLUGS } from '../directory.js';
import { handleUpapiMcpRequest, resolveToolMode } from '../http.js';

/**
 * The DIRECTORY facade — the surface an AI marketplace reviews.
 *
 * Four properties carry the whole feature and are asserted here rather than
 * described: every advertised tool is NAMED (no catch-all dispatcher), every
 * advertised tool states all four behavioural hints, reads and writes are
 * genuinely separated (and the write group is non-empty, so the separation is
 * not vacuously true), and the mode changes only what is ADVERTISED — it can
 * neither reach an operation the other modes could not, nor lose one.
 */

const noopCaller: Caller = vi.fn(async () => ({ ok: true }));

type ListedTool = {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
};

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
): Promise<ListedTool[]> {
  const res = await handleUpapiMcpRequest(
    rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, search),
    {
      caller: noopCaller,
      ...options,
    },
  );
  const parsed = JSON.parse(await res.text()) as { result: { tools: ListedTool[] } };
  return parsed.result.tools;
}

const SERVED = createUpapiToolSpecs({
  caller: noopCaller,
  filter: isDirectoryListedOperation,
});

describe('the flagship list tracks the live catalog', () => {
  it('names only slugs the catalog still has', () => {
    const known = new Set(OPERATIONS.map((op) => op.slug));
    const missing = DIRECTORY_FLAGSHIP_SLUGS.filter((slug) => !known.has(slug));
    expect(missing).toEqual([]);
  });

  it('names only slugs this surface is allowed to advertise', () => {
    // A flagship slug that is also a withheld category would be a listing this
    // transport deliberately refuses — caught here rather than by a reviewer.
    const withheld = new Set(
      OPERATIONS.filter((op) => !isDirectoryListedOperation(op)).map((op) => op.slug),
    );
    expect(DIRECTORY_FLAGSHIP_SLUGS.filter((slug) => withheld.has(slug))).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(DIRECTORY_FLAGSHIP_SLUGS).size).toBe(DIRECTORY_FLAGSHIP_SLUGS.length);
  });
});

describe('createDirectoryEntries splits on the read/write hint', () => {
  const { read, write } = createDirectoryEntries(SERVED);

  it('puts every read-only flagship in `read` and nothing else', () => {
    expect(read.length).toBeGreaterThan(0);
    for (const entry of read) {
      expect(entry.annotations.readOnlyHint).toBe(true);
      expect(entry.annotations.destructiveHint).toBe(false);
    }
  });

  it('has a NON-EMPTY write group, so the separation is a real claim', () => {
    // If this ever empties, the read/write split stops meaning anything and the
    // listing quietly becomes "everything is read-only" — which is the exact
    // false promise the annotations exist to prevent.
    expect(write.length).toBeGreaterThan(0);
    for (const entry of write) expect(entry.annotations.readOnlyHint).toBe(false);
  });

  it('covers every flagship slug exactly once between the two groups', () => {
    const covered = [...read, ...write].map((entry) => entry.name).sort();
    const expected = DIRECTORY_FLAGSHIP_SLUGS.map(
      (slug) => SERVED.find((spec) => spec.slug === slug)?.name,
    )
      .filter((name): name is string => name !== undefined)
      .sort();
    expect(covered).toEqual(expected);
  });

  it('drops a flagship slug the transport does not serve, instead of resurrecting it', () => {
    const withoutMaps = SERVED.filter((spec) => !spec.slug.startsWith('google-maps-'));
    const { read: narrowed, write: narrowedWrite } = createDirectoryEntries(withoutMaps);
    const names = [...narrowed, ...narrowedWrite].map((entry) => entry.name);
    expect(names.some((name) => name.startsWith('google_maps'))).toBe(false);
  });
});

describe('?tools=directory', () => {
  it('is a mode the URL can select', () => {
    expect(resolveToolMode(rpc({}, '?tools=directory'))).toBe('directory');
    expect(resolveToolMode(rpc({}, '?tools=nonsense'))).toBe('compact');
    expect(resolveToolMode(rpc({}, '?tools=full'))).toBe('full');
  });

  it('advertises exactly the flagship tools, reads before writes', async () => {
    const tools = await listTools('?tools=directory');
    const { read, write } = createDirectoryEntries(SERVED);
    expect(tools.map((tool) => tool.name)).toEqual([...read, ...write].map((entry) => entry.name));
  });

  it('advertises NO catch-all dispatcher', async () => {
    // The review criterion this whole mode exists for: a single tool taking a
    // target/method parameter is a rejection, and `call_op` is precisely that.
    const names = (await listTools('?tools=directory')).map((tool) => tool.name);
    expect(names).not.toContain(CALL_OP_TOOL_NAME);
    expect(names).not.toContain(SEARCH_OPS_TOOL_NAME);
  });

  it('states all four hints, a title and a description on every tool', async () => {
    for (const tool of await listTools('?tools=directory')) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it('never advertises a withheld operation', async () => {
    const withheldNames = new Set(
      OPERATIONS.filter((op) => !isDirectoryListedOperation(op)).map((op) => op.operationId),
    );
    const listed = (await listTools('?tools=directory')).map((tool) => tool.name);
    expect(listed.filter((name) => withheldNames.has(name))).toEqual([]);
  });

  it('keeps the access decision identical to the other modes', async () => {
    // Listed here, so callable; and an operation this mode does NOT list is
    // still callable by name, because the table is presentation and `specs` is
    // access. Both directions matter: one proves no loss, the other no gain.
    const listedName = (await listTools('?tools=directory'))[0]?.name;
    expect(listedName).toBeDefined();

    const unlisted = SERVED.find((spec) => !DIRECTORY_FLAGSHIP_SLUGS.includes(spec.slug));
    expect(unlisted).toBeDefined();

    for (const name of [listedName, unlisted?.name]) {
      const res = await handleUpapiMcpRequest(
        rpc(
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } },
          '?tools=directory',
        ),
        { caller: noopCaller },
      );
      const parsed = JSON.parse(await res.text()) as { result: { isError?: boolean } };
      expect(parsed.result.isError, name).not.toBe(true);
    }
  });

  it('advertises nothing executable to a caller that may not execute', async () => {
    const names = (await listTools('?tools=directory', { canExecute: false })).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([SEARCH_OPS_TOOL_NAME]);
  });
});

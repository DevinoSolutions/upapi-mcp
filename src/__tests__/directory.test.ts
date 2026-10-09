import { describe, expect, it, vi } from 'vitest';
import { OPERATIONS } from '@upapi/sdk';
import { createUpapiToolSpecs, type Caller } from '../tools.js';
import { CALL_OP_TOOL_NAME, SEARCH_OPS_TOOL_NAME } from '../facade.js';
import {
  CLAUDE_LISTING_SLUGS,
  createClaudeEntries,
  createDirectoryEntries,
  DIRECTORY_FLAGSHIP_SLUGS,
  OWN_FILES_NOTICE,
} from '../directory.js';
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

/**
 * Operations that read a third party by fetching its web pages rather than
 * through an API it publishes. Served in every mode (callable by name, listed
 * in `full`) but never ADVERTISED by the directory listing: that listing is what
 * an AI marketplace reviews, and OpenAI's app-submission guidelines refuse a
 * surface that will "scrape external websites, relay queries, or integrate with
 * third-party APIs without proper authorization". The 2026-09-22 ChatGPT Apps
 * rejection named that shape; keeping these off the listing is the fix, and
 * this list is what stops them creeping back.
 */
const SCRAPED_SOURCE_SLUGS: readonly string[] = [
  'google-maps-search.post',
  'google-maps-place.get',
  'google-maps-reviews.get',
  'web-search.post',
];

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

const SERVED = createUpapiToolSpecs({ caller: noopCaller });

describe('the flagship list tracks the live catalog', () => {
  it('names only slugs the catalog still has', () => {
    const known = new Set(OPERATIONS.map((op) => op.slug));
    const missing = DIRECTORY_FLAGSHIP_SLUGS.filter((slug) => !known.has(slug));
    expect(missing).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(DIRECTORY_FLAGSHIP_SLUGS).size).toBe(DIRECTORY_FLAGSHIP_SLUGS.length);
  });

  it('keeps the scraped-source operations off the listing, not out of the catalog', () => {
    // Both halves matter. Still served: this is a listing decision, exactly as
    // `selectListedTools` documents, and a slug that vanished from the catalog
    // would make the exclusion below pass for the wrong reason.
    const served = new Set(SERVED.map((spec) => spec.slug));
    for (const slug of SCRAPED_SOURCE_SLUGS) expect(served.has(slug), slug).toBe(true);
    expect(DIRECTORY_FLAGSHIP_SLUGS.filter((slug) => SCRAPED_SOURCE_SLUGS.includes(slug))).toEqual(
      [],
    );
  });

  it('is the 11 tools the listing copy quotes', () => {
    // `apps/docs/content/docs/mcp-clients.mdx` and `packages/mcp/README.md`
    // quote this number. A change here is a change there.
    expect(DIRECTORY_FLAGSHIP_SLUGS).toHaveLength(11);
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
    const screenshot = SERVED.find((spec) => spec.slug === 'screenshot.post');
    expect(screenshot).toBeDefined();
    const withoutScreenshot = SERVED.filter((spec) => spec !== screenshot);
    const { read: narrowed, write: narrowedWrite } = createDirectoryEntries(withoutScreenshot);
    const names = [...narrowed, ...narrowedWrite].map((entry) => entry.name);
    expect(names).not.toContain(screenshot!.name);
    expect(names).toHaveLength(DIRECTORY_FLAGSHIP_SLUGS.length - 1);
  });
});

describe('?tools=directory', () => {
  it('is a mode the URL can select', () => {
    expect(resolveToolMode(rpc({}, '?tools=directory'))).toBe('directory');
    expect(resolveToolMode(rpc({}, '?tools=nonsense'))).toBe('compact');
    expect(resolveToolMode(rpc({}, '?tools=full'))).toBe('full');
  });

  it('is selected on the exact hosted path, /api/mcp?tools=directory', () => {
    // The URL a marketplace is given verbatim. The path is asserted alongside
    // the mode so that a request whose query string was lost on the way in
    // would fail here rather than hand a reviewer the compact table.
    const request = rpc({}, '?tools=directory');
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/mcp');
    expect(url.search).toBe('?tools=directory');
    expect(resolveToolMode(request)).toBe('directory');
  });

  it('advertises none of the scraped-source operations', async () => {
    const names = (await listTools('?tools=directory')).map((tool) => tool.name);
    const scraped = SERVED.filter((spec) => SCRAPED_SOURCE_SLUGS.includes(spec.slug));
    // All four are still served, so their absence below is the listing's doing.
    expect(scraped).toHaveLength(SCRAPED_SOURCE_SLUGS.length);
    for (const spec of scraped) expect(names, spec.slug).not.toContain(spec.name);
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

/**
 * The two operations taken off BOTH listings on 2026-10-09 (owner decision).
 * Listing only: they stay served, callable by name, and listed in `full`.
 */
const DELISTED_SLUGS: readonly string[] = ['github-user.get', 'ip-geolocation.get'];

/** Proxy / bot-wall wording a listing must never carry, in prose or schema. */
const PROXY_WORDING = /prox(y|ies|ied)|bot[ -]?wall|residential|datacenter|captcha/i;

const LISTING_MODES = ['directory', 'claude'] as const;

const OWN_FILES_SLUGS: readonly string[] = [
  'image-ocr.post',
  'pdf-extract-text.post',
  'audio-transcribe.post',
];

function nameOf(slug: string): string {
  const spec = SERVED.find((candidate) => candidate.slug === slug);
  if (!spec) throw new Error(`not served: ${slug}`);
  return spec.name;
}

type ListedToolWithSchema = ListedTool & { inputSchema: Record<string, unknown> };

async function listToolsWithSchemas(search: string): Promise<ListedToolWithSchema[]> {
  return (await listTools(search)) as ListedToolWithSchema[];
}

/** `isError` of a by-name call with empty arguments; `undefined` means it ran. */
async function callByName(name: string, search: string): Promise<boolean | undefined> {
  const res = await handleUpapiMcpRequest(
    rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: {} } }, search),
    { caller: noopCaller },
  );
  const parsed = JSON.parse(await res.text()) as { result: { isError?: boolean } };
  return parsed.result.isError;
}

describe('the two listing sets, pinned', () => {
  it('the ChatGPT directory listing is exactly these 11 operations', () => {
    expect([...DIRECTORY_FLAGSHIP_SLUGS]).toEqual([
      'fetch-markdown.post',
      'screenshot.post',
      'html-to-pdf.post',
      'pdf-extract-text.post',
      'image-ocr.post',
      'audio-transcribe.post',
      'audio-transcribe-result.get',
      'github-repo.get',
      'npm-package.get',
      'wikipedia-article.get',
      'currency-convert.get',
    ]);
  });

  it('the Claude listing is exactly the operations upAPI computes itself', () => {
    expect([...CLAUDE_LISTING_SLUGS]).toEqual([
      'fetch-markdown.post',
      'screenshot.post',
      'html-to-pdf.post',
      'pdf-extract-text.post',
      'image-ocr.post',
      'audio-transcribe.post',
      'audio-transcribe-result.get',
      'text-analyze.post',
    ]);
    const known = new Set(OPERATIONS.map((op) => op.slug));
    expect(CLAUDE_LISTING_SLUGS.filter((slug) => !known.has(slug))).toEqual([]);
    expect(new Set(CLAUDE_LISTING_SLUGS).size).toBe(CLAUDE_LISTING_SLUGS.length);
  });

  it('neither listing names github-user or ip-geolocation, and both stay in the catalog', () => {
    const served = new Set(SERVED.map((spec) => spec.slug));
    for (const slug of DELISTED_SLUGS) {
      expect(served.has(slug), slug).toBe(true);
      expect(DIRECTORY_FLAGSHIP_SLUGS, slug).not.toContain(slug);
      expect(CLAUDE_LISTING_SLUGS, slug).not.toContain(slug);
    }
  });

  it('the Claude listing keeps the scraped-source operations off too', () => {
    expect(CLAUDE_LISTING_SLUGS.filter((slug) => SCRAPED_SOURCE_SLUGS.includes(slug))).toEqual([]);
  });

  it('createClaudeEntries covers every Claude slug once, split on the read hint', () => {
    const { read, write } = createClaudeEntries(SERVED);
    expect([...read, ...write].map((entry) => entry.name).sort()).toEqual(
      CLAUDE_LISTING_SLUGS.map(nameOf).sort(),
    );
    for (const entry of read) expect(entry.annotations.readOnlyHint).toBe(true);
    expect(write.length).toBeGreaterThan(0);
    for (const entry of write) expect(entry.annotations.readOnlyHint).toBe(false);
  });
});

describe('?tools=claude', () => {
  it('is a mode the URL can select, on the exact hosted path', () => {
    const request = rpc({}, '?tools=claude');
    expect(new URL(request.url).pathname).toBe('/api/mcp');
    expect(resolveToolMode(request)).toBe('claude');
  });

  it('advertises exactly the Claude tools, reads before writes, with no dispatcher', async () => {
    const names = (await listTools('?tools=claude')).map((tool) => tool.name);
    const { read, write } = createClaudeEntries(SERVED);
    expect(names).toEqual([...read, ...write].map((entry) => entry.name));
    expect([...names].sort()).toEqual(CLAUDE_LISTING_SLUGS.map(nameOf).sort());
    expect(names).not.toContain(CALL_OP_TOOL_NAME);
    expect(names).not.toContain(SEARCH_OPS_TOOL_NAME);
  });

  it('states all four hints, a title and a description on every tool', async () => {
    for (const tool of await listTools('?tools=claude')) {
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

  it('advertises nothing executable to a caller that may not execute', async () => {
    const names = (await listTools('?tools=claude', { canExecute: false })).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([SEARCH_OPS_TOOL_NAME]);
  });
});

describe('listing wording', () => {
  it.each(LISTING_MODES)(
    '?tools=%s carries no proxy or bot-wall wording in any title, description or schema',
    async (mode) => {
      const tools = await listToolsWithSchemas(`?tools=${mode}`);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.title ?? '', tool.name).not.toMatch(PROXY_WORDING);
        expect(tool.description ?? '', tool.name).not.toMatch(PROXY_WORDING);
        expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(PROXY_WORDING);
      }
    },
  );

  it.each(LISTING_MODES)(
    '?tools=%s appends the own-files notice to OCR, PDF text and transcription only',
    async (mode) => {
      const noticed = new Set(OWN_FILES_SLUGS.map(nameOf));
      const tools = await listTools(`?tools=${mode}`);
      for (const name of noticed) expect(tools.map((tool) => tool.name)).toContain(name);
      for (const tool of tools) {
        if (noticed.has(tool.name)) {
          expect(tool.description, tool.name).toContain(OWN_FILES_NOTICE);
          // The slug/cost sentence still closes the description, as in every mode.
          expect(tool.description, tool.name).toMatch(
            /Costs \d+ units? of monthly quota per call\.$/,
          );
        } else {
          expect(tool.description, tool.name).not.toContain(OWN_FILES_NOTICE);
        }
      }
    },
  );

  it('rewords the listings only: the catalog and full mode keep their own text', async () => {
    // The API docs and the other modes are generated from the catalog, so the
    // catalog itself must be untouched — the override lives in directory.ts.
    const fullTools = await listToolsWithSchemas('?tools=full');
    const fetchMarkdown = SERVED.find((spec) => spec.slug === 'fetch-markdown.post')!;
    const catalog = OPERATIONS.find((op) => op.slug === 'fetch-markdown.post')!;
    expect(fetchMarkdown.summary).toBe(catalog.description);
    const full = fullTools.find((tool) => tool.name === fetchMarkdown.name)!;
    expect(full.description).toBe(fetchMarkdown.description);
    expect(full.inputSchema).toEqual(fetchMarkdown.inputSchema);
    for (const slug of OWN_FILES_SLUGS) {
      const spec = SERVED.find((candidate) => candidate.slug === slug)!;
      const listed = fullTools.find((tool) => tool.name === spec.name)!;
      expect(listed.description, slug).toBe(spec.description);
      expect(listed.description, slug).not.toContain(OWN_FILES_NOTICE);
    }
  });

  it('keeps every listed input schema identical to the served one but for descriptions', async () => {
    // A listing must never advertise an input the operation would validate
    // differently: only property DESCRIPTIONS may be reworded.
    const strip = (schema: unknown): unknown =>
      JSON.parse(JSON.stringify(schema), (key: string, value: unknown) =>
        key === 'description' ? undefined : value,
      ) as unknown;
    for (const mode of LISTING_MODES) {
      for (const tool of await listToolsWithSchemas(`?tools=${mode}`)) {
        const spec = SERVED.find((candidate) => candidate.name === tool.name)!;
        expect(strip(tool.inputSchema), tool.name).toEqual(strip(spec.inputSchema));
      }
    }
  });
});

describe('what the listings do NOT change', () => {
  it('the default (compact) surface is unchanged', async () => {
    expect((await listTools('')).map((tool) => tool.name)).toEqual([
      SEARCH_OPS_TOOL_NAME,
      CALL_OP_TOOL_NAME,
      'web_search_post',
      'github_repo_get',
      'wikipedia_article_get',
    ]);
  });

  it('full still lists every operation, the delisted two included', async () => {
    const names = (await listTools('?tools=full')).map((tool) => tool.name);
    expect([...names].sort()).toEqual(OPERATIONS.map((op) => op.operationId).sort());
    for (const slug of DELISTED_SLUGS) expect(names, slug).toContain(nameOf(slug));
  });

  it.each(['', '?tools=full', '?tools=directory', '?tools=claude'])(
    'github-user and ip-geolocation stay callable by name on "%s"',
    async (search) => {
      for (const slug of DELISTED_SLUGS) {
        expect(await callByName(nameOf(slug), search), slug).not.toBe(true);
      }
    },
  );

  it('an operation outside the Claude listing stays callable by name on ?tools=claude', async () => {
    const unlisted = SERVED.find((spec) => !CLAUDE_LISTING_SLUGS.includes(spec.slug))!;
    expect(await callByName(unlisted.name, '?tools=claude')).not.toBe(true);
    const listed = (await listTools('?tools=claude'))[0]!.name;
    expect(await callByName(listed, '?tools=claude')).not.toBe(true);
  });
});

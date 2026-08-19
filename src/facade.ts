import type { McpToolAnnotations, ToolCallResult, UpapiToolSpec } from './tools.js';

/**
 * The COMPACT tool surface: `search_ops` + `call_op` instead of one tool per
 * operation.
 *
 * A hosted MCP connection pays for its tool table on every single turn — the
 * whole `tools/list` result is re-sent as context. upAPI's directory-listed
 * catalog is 26 operations today and each carries the worker's real JSON Schema,
 * so the full table is tens of kilobytes and lands squarely in the range where
 * clients start reporting degraded tool selection. The compact table is two
 * meta-tools plus a handful of always-on operations, and it stays a few
 * kilobytes no matter how large the catalog grows.
 *
 * Nothing here is a second execution path. `call_op` resolves a slug against the
 * SAME `UpapiToolSpec` objects the per-op tools are built from and invokes
 * `spec.call`, so metering, gating, error rendering, and the withheld-category
 * exclusion are byte-identical — a caller cannot reach anything through the
 * facade that the per-op table would not have exposed.
 */

// Declared in a leaf module so a browser bundle can read the names without
// reaching this file's import graph (the MCP SDK, ajv, the transport). Re-
// exported here so every existing importer keeps working and there is still one
// definition of each name.
export { CALL_OP_TOOL_NAME, SEARCH_OPS_TOOL_NAME } from './tool-names.js';
import { CALL_OP_TOOL_NAME, SEARCH_OPS_TOOL_NAME } from './tool-names.js';

/**
 * The operations that stay on the tool table as full tools in compact mode.
 *
 * These exist so the common case needs no discovery round-trip at all: an agent
 * asked to "look this up" can act immediately, and only reaches for `search_ops`
 * when it wants something else. Three, because each one costs its whole JSON
 * Schema in context and the budget test caps the compact table.
 *
 * Chosen as the three highest-frequency intents an agent forms WITHOUT being
 * told upAPI exists — open-web retrieval, a repository lookup, an encyclopedic
 * fact — mapped onto the catalog:
 *
 *  - `web-search.post` — the general retrieval primitive; anything an agent
 *    cannot answer from context starts here.
 *  - `github-repo.get` — the dev-tools catalog's most requested single lookup,
 *    and the one an agent reaches for while reasoning about code.
 *  - `wikipedia-article.get` — grounded factual lookup with no query planning.
 *
 * `reddit-search-posts.get` would otherwise be an obvious third pick by raw
 * demand, and is deliberately NOT here: it is a Social Media operation, which
 * `DIRECTORY_EXCLUDED_CATEGORIES` withholds from this whole surface. Listing it
 * always-on would have quietly re-admitted a withheld category — the facade must
 * never widen the table, so the always-on set is intersected with what the
 * transport already decided to serve (see `createFacadeEntries`).
 */
export const ALWAYS_ON_SLUGS: readonly string[] = [
  'web-search.post',
  'github-repo.get',
  'wikipedia-article.get',
];

/**
 * Anything a tool table can list and a client can call.
 *
 * `UpapiToolSpec` satisfies this structurally, so per-op tools and the two
 * meta-tools flow through one listing path and one dispatch path in `http.ts`
 * rather than each growing its own branch.
 */
export type McpToolEntry = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: McpToolAnnotations;
  call: (input: unknown) => Promise<ToolCallResult>;
};

/**
 * The one "no such tool" answer, shared by the per-op path and `call_op`.
 *
 * Reported as a failed CALL rather than a protocol error, and saying nothing
 * about WHY the name is absent: from the caller's side a withheld operation, a
 * typo, and an operation that never existed are the same fact, and the tool
 * table is already filtered to what this caller may invoke.
 */
export function toolNotFound(name: string): ToolCallResult {
  return {
    content: [{ type: 'text' as const, text: `NOT_FOUND: unknown tool "${name}"` }],
    isError: true,
  };
}

/** Refusal for a tool this connection is authenticated for but not authorized to use. */
export function toolForbidden(message: string): ToolCallResult {
  return {
    content: [{ type: 'text' as const, text: `FORBIDDEN: ${message}` }],
    isError: true,
  };
}

export const EXECUTE_FORBIDDEN_MESSAGE = 'this connection is not authorized to run operations.';
export const SEARCH_FORBIDDEN_MESSAGE = 'this connection is not authorized to search the catalog.';

/**
 * `search_ops` reads an in-process table built from the SDK catalog at import
 * time. It reaches no network, touches no upstream, and returns the same answer
 * for the same arguments — so unlike every operation tool on this surface it is
 * genuinely closed-world.
 */
const SEARCH_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * `call_op` is a DISPATCHER, and its annotations describe the mechanism rather
 * than today's catalog contents.
 *
 * Every operation this surface currently exposes is a third-party read, so it is
 * tempting to mark `call_op` read-only and idempotent. That would be a promise
 * about DATA, not about code: the set it can reach is whatever the transport
 * lists, and a single future operation in a listed category would silently
 * convert a "safe to auto-run" annotation into a false one, with no diff to
 * review. So the honest hints for the mechanism are: not read-only (it can run
 * whatever the catalog offers), not idempotent (repeats are as repeatable as the
 * operation chosen), and open-world (every upAPI operation exists to reach a
 * system upAPI does not own).
 *
 * `destructiveHint: false` is the one claim about contents, and it is the one
 * the tests actually hold: `facade.test.ts` asserts every operation reachable
 * through this surface is non-destructive, so the day that stops being true the
 * suite fails here rather than a host discovering it at runtime.
 */
const CALL_ANNOTATIONS: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'What you want to do, in plain words — e.g. "search the web", "github repository stats", "convert currency". Pass an empty string to browse everything.',
    },
    category: {
      type: 'string',
      description:
        'Restrict to one catalog category, e.g. "Search", "Developer Tools", "Data". Case-insensitive.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      default: 10,
      description: 'Maximum operations to return. Defaults to 10.',
    },
  },
  required: ['query'],
  additionalProperties: false,
};

const CALL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    slug: {
      type: 'string',
      description: 'Operation slug exactly as `search_ops` returned it, e.g. "github-repo.get".',
    },
    input: {
      type: 'object',
      description:
        "The operation's own arguments, matching the parameters `search_ops` listed for it. Omit for an operation that takes none.",
      additionalProperties: true,
    },
  },
  required: ['slug'],
  additionalProperties: false,
};

/** Result descriptions are clipped: a 26-row answer must stay cheap to read. */
const MAX_SUMMARY_LENGTH = 180;

function clip(text: string, max = MAX_SUMMARY_LENGTH): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

type ParameterSummary = { name: string; type: string; required: boolean };

/**
 * The operation's parameters, flattened to name/type/required.
 *
 * Deliberately NOT the whole JSON Schema: reproducing it here would rebuild the
 * exact context cost the facade exists to avoid. An agent that needs the full
 * contract calls the operation and reads the classified `INVALID_INPUT` failure,
 * or switches this connection to `?tools=full`.
 */
function summarizeParameters(schema: Record<string, unknown>): ParameterSummary[] {
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null) return [];
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  );
  return Object.entries(properties as Record<string, unknown>).map(([name, raw]) => {
    const field = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const type = field['type'];
    return {
      name,
      type: typeof type === 'string' ? type : Array.isArray(type) ? type.join('|') : 'any',
      required: required.has(name),
    };
  });
}

type SearchMatch = {
  slug: string;
  title: string;
  description: string;
  category: string;
  unitWeight: number;
  parameters: ParameterSummary[];
};

/**
 * Score one operation against the query terms.
 *
 * Ordinary substring matching over the fields an author already wrote, weighted
 * so an exact slug beats a passing mention in prose. Returns 0 for no match, and
 * every term must hit something — an agent asking for "github issues" should not
 * be handed every operation that merely says "github".
 */
function scoreOperation(spec: UpapiToolSpec, terms: string[]): number {
  if (terms.length === 0) return 1;
  const slug = spec.slug.toLowerCase();
  const title = spec.title.toLowerCase();
  const summary = spec.summary.toLowerCase();
  const category = spec.category.toLowerCase();
  const tags = spec.tags.map((tag) => tag.toLowerCase());

  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (slug === term) best = 100;
    else if (slug.includes(term)) best = Math.max(best, 40);
    if (title.includes(term)) best = Math.max(best, 30);
    if (tags.some((tag) => tag.includes(term))) best = Math.max(best, 20);
    if (category.includes(term)) best = Math.max(best, 15);
    if (summary.includes(term)) best = Math.max(best, 10);
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function searchSpecs(
  specs: readonly UpapiToolSpec[],
  args: { query: string; category?: string; limit: number },
): { total: number; matches: SearchMatch[] } {
  const terms = args.query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  const wantedCategory = args.category?.trim().toLowerCase();

  const scored: Array<{ spec: UpapiToolSpec; score: number }> = [];
  for (const spec of specs) {
    if (wantedCategory && spec.category.toLowerCase() !== wantedCategory) continue;
    const score = scoreOperation(spec, terms);
    if (score > 0) scored.push({ spec, score });
  }
  // Ties break on slug so the same query always returns the same order — an
  // agent re-running a search must not see the list reshuffle under it.
  scored.sort((a, b) => b.score - a.score || a.spec.slug.localeCompare(b.spec.slug));

  return {
    total: scored.length,
    matches: scored.slice(0, args.limit).map(({ spec }) => ({
      slug: spec.slug,
      title: spec.title,
      description: clip(spec.summary),
      category: spec.category,
      unitWeight: spec.unitWeight,
      parameters: summarizeParameters(spec.inputSchema),
    })),
  };
}

function readSearchArgs(input: unknown): { query: string; category?: string; limit: number } {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const query = typeof raw['query'] === 'string' ? raw['query'] : '';
  const category = typeof raw['category'] === 'string' ? raw['category'] : undefined;
  const limitRaw = Number(raw['limit']);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, Math.floor(limitRaw))) : 10;
  return category === undefined ? { query, limit } : { query, category, limit };
}

/**
 * The two meta-tools, bound to the tool specs this transport decided to serve.
 *
 * `specs` is already filtered (directory exclusions, then any host filter), so
 * both meta-tools inherit that scope by construction rather than by re-applying
 * the same rules a second time and risking a different answer.
 */
export function createFacadeEntries(specs: readonly UpapiToolSpec[]): {
  search: McpToolEntry;
  call: McpToolEntry;
  alwaysOn: UpapiToolSpec[];
} {
  const bySlug = new Map(specs.map((spec) => [spec.slug, spec]));
  const categories = [...new Set(specs.map((spec) => spec.category))].sort();

  const search: McpToolEntry = {
    name: SEARCH_OPS_TOOL_NAME,
    title: 'Search upAPI operations',
    description:
      `Find upAPI operations to call. upAPI is an API marketplace: ${specs.length} operations across ` +
      `${categories.length} categories (${categories.join(', ')}) — web search, SERP, dev-tool and ` +
      'package lookups, geo/finance/weather data, page and sitemap parsing. Returns each match with ' +
      'its slug, what it does, its parameters, and what one call costs in quota units. Run one with ' +
      `\`${CALL_OP_TOOL_NAME}\`.`,
    inputSchema: SEARCH_INPUT_SCHEMA,
    annotations: SEARCH_ANNOTATIONS,
    call: async (input: unknown): Promise<ToolCallResult> => {
      const args = readSearchArgs(input);
      const { total, matches } = searchSpecs(specs, args);
      const payload = {
        matches,
        returned: matches.length,
        total,
        categories,
        next:
          matches.length === 0
            ? 'No operation matched. Try fewer or broader words, or an empty query to browse everything.'
            : `Run one with ${CALL_OP_TOOL_NAME}: { "slug": "<slug>", "input": { … } }`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  };

  const call: McpToolEntry = {
    name: CALL_OP_TOOL_NAME,
    title: 'Run an upAPI operation',
    description:
      `Run one upAPI operation by slug. Discover slugs and their parameters with \`${SEARCH_OPS_TOOL_NAME}\` ` +
      "first. Costs the operation's own quota units per call (1 for most, more for search/browser-backed " +
      'ones) — the exact figure is in the search result. Failures come back as a tool error carrying ' +
      "upAPI's error code, not as a broken session.",
    inputSchema: CALL_INPUT_SCHEMA,
    annotations: CALL_ANNOTATIONS,
    call: async (input: unknown): Promise<ToolCallResult> => {
      const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<
        string,
        unknown
      >;
      const slug = typeof raw['slug'] === 'string' ? raw['slug'] : '';
      const spec = bySlug.get(slug);
      // Same answer the per-op table gives for a name it does not carry — a
      // withheld operation must not become reachable, or discoverable, by being
      // named through the dispatcher instead.
      if (!spec) return toolNotFound(slug);
      const opInput = raw['input'];
      return spec.call(typeof opInput === 'object' && opInput !== null ? opInput : {});
    },
  };

  // Intersected with what is actually served: an always-on slug that this
  // transport withholds (or a host filter removed, or the catalog dropped) is
  // simply absent rather than resurrected.
  const alwaysOn = ALWAYS_ON_SLUGS.map((slug) => bySlug.get(slug)).filter(
    (spec): spec is UpapiToolSpec => spec !== undefined,
  );

  return { search, call, alwaysOn };
}

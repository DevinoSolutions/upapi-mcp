import type { McpToolEntry } from './facade.js';
import { describeTool, type UpapiToolSpec } from './tools.js';

/**
 * The LISTING tool surfaces: curated sets of NAMED tools, read tools and write
 * tools kept apart, and every tool carrying its four behavioural hints.
 *
 * These are more tables on the same registry, not more registries. `compact`
 * (`search_ops` + `call_op`) optimizes for context budget; `full` optimizes for
 * an agent that wants every schema up front; `directory` and `claude` optimize
 * for REVIEW — they are the shape an AI marketplace's listing criteria ask for,
 * and `directory` is the shape a Claude Desktop Extension ships with.
 *
 * Why listing modes rather than reusing `compact`: the Anthropic Connectors
 * review criteria name a catch-all dispatcher with a target parameter as a
 * rejection reason, and `call_op` is exactly that shape — deliberately, because
 * it is the right answer to a 61-operation catalog re-sent on every turn. Both
 * are correct for their audience, so both exist and neither is deleted.
 *
 * Nothing here can widen the surface. Entries are built from the SAME
 * `UpapiToolSpec` objects every other mode lists, so metering, gating and error
 * rendering are byte-identical, and a slug this transport does not serve (a host
 * filter removed it, or the catalog dropped it) is simply absent rather than
 * resurrected. The only thing a listing may change is the WORDING it advertises
 * (see `LISTING_OVERRIDES`); the API docs and the other modes keep the catalog's
 * own text.
 */

/**
 * The operations the ChatGPT listing (`?tools=directory`) advertises by name.
 *
 * Curated, not derived: a listing is a promise about what this connector is
 * FOR, and a set that grew itself every time an operation shipped would make
 * that promise on nobody's authority. Chosen as the operations that are (a)
 * either computed on upAPI's own infrastructure — upAPI runs the browser, the
 * PDF and OCR engines and the transcription GPU itself, so these are not
 * one-line wrappers an agent could write — or reads of an API the third party
 * publishes for that purpose (GitHub repositories, npm, Wikipedia, ECB rates);
 * and (b) legible to a reviewer reading tool names alone.
 *
 * Deliberately NOT here: operations that read a third party by fetching its
 * web pages rather than through an API it publishes — the Google Maps trio
 * (`google-maps-search.post`, `google-maps-place.get`, `google-maps-reviews.get`)
 * and `web-search.post`. They stay served (callable by name in every mode and
 * listed in `full`), but this listing is what an AI marketplace reviews, and
 * OpenAI's app-submission guidelines refuse a surface that will "scrape
 * external websites, relay queries, or integrate with third-party APIs without
 * proper authorization". The 2026-09-22 ChatGPT Apps rejection named exactly
 * that shape. Also off this listing since 2026-10-09 (owner decision):
 * `github-user.get` and `ip-geolocation.get`. Both stay served and callable by
 * name everywhere. `directory.test.ts` pins every exclusion so none can creep
 * back.
 *
 * Ordered by cluster, and every entry is asserted against the live catalog by
 * `directory.test.ts`: a renamed or retired slug fails the suite instead of
 * quietly shrinking the listing.
 */
export const DIRECTORY_FLAGSHIP_SLUGS: readonly string[] = [
  // Open-web rendering — the browser-backed operations upAPI runs itself.
  'fetch-markdown.post',
  'screenshot.post',
  'html-to-pdf.post',
  // Documents and media in, text out.
  'pdf-extract-text.post',
  'image-ocr.post',
  'audio-transcribe.post',
  'audio-transcribe-result.get',
  // Developer lookups — official REST APIs.
  'github-repo.get',
  'npm-package.get',
  // Reference data — official public APIs.
  'wikipedia-article.get',
  'currency-convert.get',
];

/**
 * The operations the Claude listing (`?tools=claude`) advertises by name: only
 * the ones upAPI COMPUTES itself — its own browser, PDF engine, OCR engine,
 * transcription GPU and text analysis — and no read of any third-party API.
 *
 * Every other operation stays served and callable by name on this table too;
 * like `directory`, this is a listing decision and never an access one.
 */
export const CLAUDE_LISTING_SLUGS: readonly string[] = [
  // Open-web rendering — the browser-backed operations upAPI runs itself.
  'fetch-markdown.post',
  'screenshot.post',
  'html-to-pdf.post',
  // Documents and media in, text out.
  'pdf-extract-text.post',
  'image-ocr.post',
  'audio-transcribe.post',
  'audio-transcribe-result.get',
  // Pure compute, no network.
  'text-analyze.post',
];

/**
 * The data-handling sentence a listing appends to every tool that takes a
 * user's own document or media.
 *
 * True as written, and checked before it was: the PDF and OCR workers read the
 * bytes in memory (`io.BytesIO`, never a file), and the transcription GPU
 * service streams the audio to a temporary file it deletes when the job ends
 * (DevinoSolutions/gpu-service `jobs/tasks.py`). What IS kept is the RESULT —
 * the gateway's response cache holds the extracted text for up to 24 hours,
 * and a transcription job's transcript lives 24 hours so it can be polled —
 * which is why the sentence promises nothing about the text.
 */
export const OWN_FILES_NOTICE =
  'Use it on your own documents and media; it is not meant for ID documents, medical records or payment-card details, and upAPI does not keep the file after the call.';

/**
 * Listing-only rewording of an operation's summary, and of any input-field
 * description that says the same thing.
 *
 * The catalog's text is written for the API docs, where how a page is fetched
 * (and the proxied retry behind it) is useful to a developer. A marketplace
 * listing is read by a reviewer deciding what the connector is for, so it says
 * what the tool does for the user and nothing about how upAPI reaches a
 * reluctant origin. `directory.test.ts` asserts no listed tool, in either
 * listing, carries proxy or bot-wall wording in its description or schema.
 *
 * `summary` replaces the catalog description; `fields` replaces the named
 * input-property descriptions; `notice` appends `OWN_FILES_NOTICE`.
 */
type ListingOverride = {
  summary?: string;
  fields?: Readonly<Record<string, string>>;
  notice?: true;
};

const LISTING_OVERRIDES: Readonly<Record<string, ListingOverride>> = {
  'fetch-markdown.post': {
    summary:
      'Convert any web page into clean, LLM-ready Markdown. Fetches the page over plain HTTP, removes ' +
      'boilerplate with Mozilla Readability, and converts with GitHub-flavored Markdown tables, lists ' +
      'and code blocks. Article mode is verified against a whole-page conversion and downgrades itself ' +
      'when Readability strips too much, so you are never handed a gutted page. Returns the markdown ' +
      'plus title, byline, language, excerpt, the extracted link list and the final URL after ' +
      'redirects. No browser is used, so a client-rendered page is reported as an error rather than ' +
      'as empty content.',
    fields: {
      timeoutMs:
        'Total network budget in milliseconds for fetching the page (e.g. 20000). Capped below the 28s API-gateway edge timeout.',
    },
  },
  'pdf-extract-text.post': { notice: true },
  'image-ocr.post': { notice: true },
  'audio-transcribe.post': { notice: true },
};

/** The input schema with the named property descriptions replaced, copied, never mutated. */
function withFieldDescriptions(
  schema: Record<string, unknown>,
  fields: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const properties = schema['properties'];
  if (!properties || typeof properties !== 'object') return schema;
  const next: Record<string, unknown> = { ...(properties as Record<string, unknown>) };
  for (const [name, description] of Object.entries(fields)) {
    const property = next[name];
    // A field the catalog no longer has is skipped rather than invented: the
    // listing must never advertise an input the operation would refuse.
    if (property && typeof property === 'object') {
      next[name] = { ...(property as Record<string, unknown>), description };
    }
  }
  return { ...schema, properties: next };
}

/**
 * The entry a listing advertises for `spec`: the same tool (same name, schema
 * shape, hints and `call`), with the listing's wording.
 */
function listingEntry(spec: UpapiToolSpec): McpToolEntry {
  const override = LISTING_OVERRIDES[spec.slug];
  if (!override) return spec;
  const summary = override.summary ?? spec.summary;
  return {
    ...spec,
    description: describeTool(override.notice ? `${summary} ${OWN_FILES_NOTICE}` : summary, spec),
    inputSchema: override.fields
      ? withFieldDescriptions(spec.inputSchema, override.fields)
      : spec.inputSchema,
  };
}

/**
 * A listing, split on the one hint a host uses to decide whether a call may
 * run unattended.
 *
 * The split is DERIVED from `OPERATION_ANNOTATIONS`, never hand-maintained: an
 * operation whose classification changes moves between the two groups on the
 * same commit that changes it, with no second list to forget. `read` is exactly
 * `readOnlyHint === true`; `write` is everything else — today only
 * `audio-transcribe.post`, which creates a transcription job and spends GPU
 * budget, and which therefore must not sit in the same bucket as a lookup.
 */
export type DirectoryEntries = {
  read: McpToolEntry[];
  write: McpToolEntry[];
};

/**
 * The listed tools this transport can actually serve, partitioned read/write.
 *
 * `specs` is already filtered by any host filter, so a listed slug the
 * transport does not serve is absent by construction rather than by
 * re-applying the same rule here and risking a different answer.
 */
function createListingEntries(
  specs: readonly UpapiToolSpec[],
  slugs: readonly string[],
): DirectoryEntries {
  const bySlug = new Map(specs.map((spec) => [spec.slug, spec]));
  const read: McpToolEntry[] = [];
  const write: McpToolEntry[] = [];

  for (const slug of slugs) {
    const spec = bySlug.get(slug);
    if (!spec) continue;
    (spec.annotations.readOnlyHint ? read : write).push(listingEntry(spec));
  }

  return { read, write };
}

/** The ChatGPT listing (`?tools=directory`). */
export function createDirectoryEntries(specs: readonly UpapiToolSpec[]): DirectoryEntries {
  return createListingEntries(specs, DIRECTORY_FLAGSHIP_SLUGS);
}

/** The Claude listing (`?tools=claude`). */
export function createClaudeEntries(specs: readonly UpapiToolSpec[]): DirectoryEntries {
  return createListingEntries(specs, CLAUDE_LISTING_SLUGS);
}

import { OPERATIONS, type OperationMeta, type OperationSlug } from '@upapi/sdk';
import { formatToolFailure, toToolFailure } from './errors.js';

/**
 * The transport-neutral tool table.
 *
 * upAPI exposes its operations over three surfaces — the REST gateway, a local
 * stdio MCP server, and a hosted HTTP MCP endpoint — and all three describe the
 * SAME operations. So the table is built once, here, from @upapi/sdk's generated
 * catalog, and each transport supplies only HOW a call is executed. That
 * injection point is `Caller`, and it is why there is no HTTP client in this
 * file: the stdio bin forwards to api.upapi.io with the user's API key, while the
 * hosted route runs the operation in-process through the web app's own metering.
 * Neither re-describes an operation, and neither authenticates here.
 *
 * Schemas are passed through as JSON Schema, verbatim. Both consumers accept it
 * natively — Mastra's `PublicSchema` includes `JSONSchema7`, and the MCP wire
 * format IS JSON Schema — so an agent reading `tools/list` sees the operation's
 * real parameters (formats, bounds, defaults, nullability) rather than whatever
 * survived a trip through a second schema language.
 */

/**
 * Executes one operation. Resolve with the operation's output; REJECT to signal
 * failure, ideally with `{ code, message, status?, retryAfterSeconds? }` so the
 * agent-facing text keeps upAPI's public error vocabulary.
 */
export type Caller = (slug: string, input: unknown) => Promise<unknown>;

/** Narrows the tool table, e.g. to one category. Return false to omit an op. */
export type ToolFilter = (op: OperationMeta) => boolean;

/**
 * Categories the HOSTED endpoint does not expose.
 *
 * This is listing scope, not a capability judgement: every one of these
 * operations stays in the product — on the REST gateway, in the try-it panel,
 * and on the keyed stdio server a developer installs deliberately. What changes
 * is only what an AI directory advertises to anyone who clicks "connect".
 *
 *  - **Social Media** — profile, post and commenter reads across Instagram,
 *    LinkedIn, TikTok, Reddit, Bluesky and Mastodon. They return third parties'
 *    personal data to an agent that reached them through a public directory, and
 *    several platforms' terms disallow the collection outright. That is a
 *    different bargain from a developer wiring the same operation into their own
 *    system with their own key, which is why the stdio surface keeps them.
 *  - **Utility** — the two `email-read-verification-*` operations. In a CI
 *    harness reading a signup code out of an inbox is ordinary QA plumbing; in a
 *    directory listing it is the bulk-account-creation primitive, and it reads
 *    that way to a reviewer no matter what we intended.
 *
 * A CATEGORY list, not a slug list, on purpose: a new social operation added to
 * the catalog tomorrow is excluded the moment it lands, with nobody having to
 * remember this file exists. `packages/mcp/src/__tests__/tools.test.ts` pins the
 * resulting set so the exposed surface cannot drift silently either way.
 */
export const DIRECTORY_EXCLUDED_CATEGORIES: readonly string[] = ['Social Media', 'Utility'];

/**
 * Slug-level companions to the category list, for operations whose catalog
 * category does not reflect why a directory must not advertise them.
 * `linkedin-profile-search.post` is a keyed-session people-search over a
 * professional network — exactly the personal-data bargain the Social Media
 * exclusion exists to refuse — but it is categorized `Search`, so the category
 * filter cannot catch it. Recategorizing it in the worker manifest would also
 * work, but that changes every catalog surface (marketplace grouping, landing
 * counts, seeded mirror) for what is a directory-only concern.
 */
export const DIRECTORY_EXCLUDED_SLUGS: readonly string[] = ['linkedin-profile-search.post'];

/** True when an operation belongs on the hosted, directory-listed surface. */
export const isDirectoryListedOperation: ToolFilter = (op) =>
  !DIRECTORY_EXCLUDED_CATEGORIES.includes(op.category) &&
  !DIRECTORY_EXCLUDED_SLUGS.includes(op.slug);

export type CreateToolsOptions = {
  caller: Caller;
  filter?: ToolFilter | undefined;
};

/** MCP `CallToolResult` content, kept structural so no SDK type is needed here. */
export type ToolContent = { type: 'text'; text: string };
export type ToolCallResult = { content: ToolContent[]; isError?: boolean };

/**
 * MCP tool annotations — the four behavioural hints a client uses to decide
 * whether a call may run unattended, and the criterion both agent marketplaces
 * review against. Every field is REQUIRED: a hint that can be omitted is a hint
 * that gets inferred, and an inferred hint is a promise nobody checked.
 */
export type McpToolAnnotations = {
  /** True only if the call cannot change ANY state, ours or the upstream's. */
  readOnlyHint: boolean;
  /** True only if the call can irreversibly delete or overwrite something. */
  destructiveHint: boolean;
  /** True if repeating the call with the same arguments adds no further effect. */
  idempotentHint: boolean;
  /** True if the call reaches a system outside upAPI's own closed domain. */
  openWorldHint: boolean;
};

/**
 * The four behavioural classes the 57 published operations fall into.
 *
 * `openWorldHint` is `true` in all three, and that is not a shortcut: upAPI is
 * an API marketplace, so EVERY published operation exists to reach a system
 * upAPI does not own — GitHub, Reddit, an IMAP host, the Wayback Machine.
 * There is no workspace/key-management tool in the published catalog (those
 * live in the dashboard and the REST gateway, not here), so there is no
 * candidate for `openWorldHint: false`. If one is ever added, it gets its own
 * class below rather than an exception inside one of these.
 */

/**
 * A plain lookup: the worker reads a third-party endpoint and writes nothing
 * anywhere. 53 of the 57 published operations.
 *
 * `readOnlyHint` here is derived from what the worker actually DOES, never from
 * the slug's `.get`/`.post` suffix. That suffix names the operation's verb on
 * upAPI's own gateway, not the request the worker makes upstream, and reading it
 * as "writes upstream" would mislabel a dozen pure scrapers — every `.post`
 * operation in this class reaches its upstream with a GET.
 *
 * Verified by grepping every worker under
 * `apps/iii/marketplace-api-worker-{python,ts}/made_by_upapi/` for an outbound
 * POST and intersecting the hits with the published catalog: the only published
 * operations that POST upstream are `instagram_check_account.py` and
 * `audio_transcribe.py` (job submission), each classified separately below. The
 * other POST-ing workers there — account creation, login, comment posting,
 * messaging — are absent from the catalog, so no tool exists for them on any
 * transport.
 */
const THIRD_PARTY_READ: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * Reads a message out of a mailbox the CALLER supplies IMAP credentials for
 * (`email-read-verification-{code,link}.post`).
 *
 * Not `readOnlyHint: true`, deliberately. Message content and flags survive the
 * call untouched — imapflow fetches bodies with `BODY.PEEK`, so nothing is
 * marked `\Seen`, and neither worker deletes, moves, or flags anything. But both
 * take the mailbox lock with imapflow's default `readOnly: false`, so the
 * server-side SELECT is read-write and clears `\Recent` for whoever opens the
 * mailbox next. That is a real change to someone's live mailbox, and it is
 * exactly the class of call a host should confirm rather than auto-run.
 * Nothing is destroyed, and a second identical call leaves the same state.
 */
const MAILBOX_READ: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `instagram-check-account.post` — the one published operation that POSTs.
 *
 * It submits the query to Instagram's/Threads' `account_recovery_ajax`
 * password-reset endpoint and reads which recovery channels come back
 * (`instagram_check_account.py`, the `session.post(...)` to
 * `/api/v1/web/accounts/account_recovery_ajax/`). No recovery message is sent
 * and nothing on the account changes, so `destructiveHint` is false — but the
 * call ENTERS a third party's account-recovery flow rather than reading a public
 * resource, so claiming `readOnlyHint: true` would overstate it. Nor is it
 * idempotent in effect: the worker's own 429 branch tells callers to space
 * requests, i.e. repeats accumulate against Instagram's abuse counters for that
 * account.
 */
const ACCOUNT_RECOVERY_PROBE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * `audio-transcribe.post` — submits a Whisper job to the GPU service and
 * returns either the finished transcript or a `jobId` to poll.
 *
 * Not `readOnlyHint: true`: the call CREATES a job (and spends real GPU budget)
 * on the transcription service, under a fresh `upapi-{uuid}` id minted per
 * call. That same fresh id is why `idempotentHint` is false — a client that
 * retries on the strength of an idempotent hint runs the same audio twice and
 * pays twice. The service accepts caller-supplied job ids and answers 409 on a
 * duplicate, so a future revision that exposes an optional caller id could
 * flip this to true; as shipped, false is the honest answer. Nothing existing
 * is deleted or overwritten, so `destructiveHint` stays false, and the
 * companion `audio-transcribe-result.get` is a pure job-record read classified
 * as THIRD_PARTY_READ above.
 */
const GPU_JOB_SUBMIT: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * Every published operation's annotations, declared explicitly.
 *
 * Keyed by `OperationSlug` — the literal union generated from the catalog — so
 * the table is EXHAUSTIVE at the type level: add an operation to the catalog and
 * this object stops compiling until the new slug is classified. That is the
 * point of doing it here rather than deriving a default inside
 * `createUpapiToolSpecs`; a default would hand an unreviewed operation the
 * read-only, safe-to-auto-run annotation set on the day it ships.
 * `packages/mcp/src/__tests__/tools.test.ts` pins the same invariant at runtime.
 */
export const OPERATION_ANNOTATIONS: Readonly<Record<OperationSlug, McpToolAnnotations>> = {
  // ── Third-party reads (55) ────────────────────────────────────────────────
  'archive-wayback.get': THIRD_PARTY_READ,
  // Renders/reads a caller-named page or document and writes nothing anywhere.
  // The three render ops (screenshot, html-to-pdf, fetch-markdown) hold a real
  // browser tab or DOM pass but upstream they only GET; the two file ops
  // (pdf-extract-text, image-ocr) compute locally and reach the open world only
  // to fetch a caller-supplied input URL; audio-transcribe-result is a pure
  // job-record read. Note for hosts: screenshot/html-to-pdf are weight-20
  // metered, so an agent looping them spends quota ~20× faster than a plain
  // HTTP op — that budget fact rides in each tool description, since no
  // annotation field expresses it.
  'audio-transcribe-result.get': THIRD_PARTY_READ,
  'fetch-markdown.post': THIRD_PARTY_READ,
  'html-to-pdf.post': THIRD_PARTY_READ,
  'image-ocr.post': THIRD_PARTY_READ,
  'pdf-extract-text.post': THIRD_PARTY_READ,
  'screenshot.post': THIRD_PARTY_READ,
  'bbc-news.get': THIRD_PARTY_READ,
  'bluesky-profile.get': THIRD_PARTY_READ,
  'cloudflare-page-title.get': THIRD_PARTY_READ,
  'crypto-price.get': THIRD_PARTY_READ,
  'currency-convert.get': THIRD_PARTY_READ,
  'detect-tech-stack.post': THIRD_PARTY_READ,
  'devto-articles-search.get': THIRD_PARTY_READ,
  'github-repo.get': THIRD_PARTY_READ,
  'github-trending.get': THIRD_PARTY_READ,
  'github-user.get': THIRD_PARTY_READ,
  'google-autocomplete.post': THIRD_PARTY_READ,
  // The three Maps operations read Google's own Maps endpoints and write nowhere.
  // Idempotent in the sense the hint means — a repeat call is safe and free of
  // side effects — even though Google's ranking makes the RESULT of a search
  // vary between calls, which is true of every search tool in this table. The
  // reviews operation is the same story with a moving corpus underneath: new
  // reviews arrive, so a repeat call is safe but need not return the same rows.
  'google-maps-place.get': THIRD_PARTY_READ,
  'google-maps-reviews.get': THIRD_PARTY_READ,
  'google-maps-search.post': THIRD_PARTY_READ,
  'hackernews-search.get': THIRD_PARTY_READ,
  'instagram-check-account-health.get': THIRD_PARTY_READ,
  'instagram-discover-location.post': THIRD_PARTY_READ,
  'instagram-get-post-commenters.post': THIRD_PARTY_READ,
  'instagram-get-post-info.post': THIRD_PARTY_READ,
  'instagram-get-user-posts.post': THIRD_PARTY_READ,
  'instagram-get-user-profile.post': THIRD_PARTY_READ,
  'ip-geolocation.get': THIRD_PARTY_READ,
  'linkedin-check-account-health.post': THIRD_PARTY_READ,
  'linkedin-get-profile.post': THIRD_PARTY_READ,
  'linkedin-profile-search.post': THIRD_PARTY_READ,
  'mastodon-profile.get': THIRD_PARTY_READ,
  'nasa-apod.get': THIRD_PARTY_READ,
  'npm-package.get': THIRD_PARTY_READ,
  'opengraph-parse.get': THIRD_PARTY_READ,
  'pokeapi-pokemon.get': THIRD_PARTY_READ,
  'pypi-package.get': THIRD_PARTY_READ,
  'reddit-check-account-health.get': THIRD_PARTY_READ,
  'reddit-check-comment-visibility.get': THIRD_PARTY_READ,
  'reddit-get-trending.get': THIRD_PARTY_READ,
  'reddit-scrape-post.get': THIRD_PARTY_READ,
  'reddit-search-posts.get': THIRD_PARTY_READ,
  'reddit-subreddit-info.get': THIRD_PARTY_READ,
  'sitemap-parse.get': THIRD_PARTY_READ,
  'stackexchange-search.get': THIRD_PARTY_READ,
  'tiktok-check-account-health.get': THIRD_PARTY_READ,
  'tiktok-discover-users.post': THIRD_PARTY_READ,
  'tiktok-get-comments.post': THIRD_PARTY_READ,
  'tiktok-get-user-profile.post': THIRD_PARTY_READ,
  'tiktok-get-video-detail.post': THIRD_PARTY_READ,
  'timezone-lookup.get': THIRD_PARTY_READ,
  'translate-text.get': THIRD_PARTY_READ,
  'weather-current.get': THIRD_PARTY_READ,
  'web-search.post': THIRD_PARTY_READ,
  'wikipedia-article.get': THIRD_PARTY_READ,

  // ── Mailbox reads, caller-supplied IMAP credentials (2) ───────────────────
  'email-read-verification-code.post': MAILBOX_READ,
  'email-read-verification-link.post': MAILBOX_READ,

  // ── Account-recovery probe (1) ────────────────────────────────────────────
  'instagram-check-account.post': ACCOUNT_RECOVERY_PROBE,

  // ── GPU job submission (1) ────────────────────────────────────────────────
  'audio-transcribe.post': GPU_JOB_SUBMIT,
};

export type UpapiToolSpec = {
  /** MCP tool name — the operation's `operationId` (slug with `.`/`-` → `_`). */
  name: string;
  slug: string;
  /** Short human title, used where a client shows one (falls back to the name). */
  title: string;
  description: string;
  /**
   * The operation's OWN description, without the slug/cost sentence `describe`
   * appends. `search_ops` renders many operations at once and re-stating the
   * slug and cost inside every row's prose — next to the structured `slug` and
   * `unitWeight` fields it already returns — would pay for the same two facts
   * twice in the agent's context.
   */
  summary: string;
  category: string;
  /** Catalog tags, carried so `search_ops` can match on them. */
  tags: readonly string[];
  /** Weighted quota units one call spends. Surfaced so agents can budget. */
  unitWeight: number;
  /** Advertised verbatim in `tools/list`. */
  inputSchema: Record<string, unknown>;
  /**
   * The operation's output shape. Documentation only — deliberately NOT
   * advertised as an MCP `outputSchema`, see `createUpapiToolSpecs`.
   */
  outputSchema: Record<string, unknown>;
  /**
   * Behavioural hints, advertised verbatim in `tools/list`. Required, never
   * optional: see `OPERATION_ANNOTATIONS`.
   */
  annotations: McpToolAnnotations;
  /** Run the operation, resolving with its output or throwing the failure. */
  execute: (input: unknown) => Promise<unknown>;
  /** Run the operation and render the MCP result, failures included. */
  call: (input: unknown) => Promise<ToolCallResult>;
};

/**
 * The tool description is what an agent uses to CHOOSE a tool, so it carries the
 * operation's own description plus the two facts invisible from the schema: which
 * slug it maps to (for anyone cross-reading the REST docs) and what a call costs
 * against the caller's quota.
 */
function describe(op: OperationMeta): string {
  const cost = op.unitWeight === 1 ? '1 unit' : `${op.unitWeight} units`;
  return `${op.description}\n\nupAPI operation \`${op.slug}\` (${op.category}). Costs ${cost} of monthly quota per call.`;
}

/**
 * The operation's declared annotations.
 *
 * `OperationMeta.slug` widens to `string`, so the exhaustiveness the
 * `Record<OperationSlug, …>` key type guarantees at compile time cannot be
 * carried through the lookup. A miss is therefore treated as a build-the-table
 * failure rather than papered over with a default: the one outcome that must
 * never happen is a tool reaching an agent with its behaviour unstated.
 */
function annotationsFor(op: OperationMeta): McpToolAnnotations {
  const annotations = OPERATION_ANNOTATIONS[op.slug as OperationSlug];
  if (!annotations) {
    throw new Error(`No MCP annotations declared for operation "${op.slug}"`);
  }
  return annotations;
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A cyclic or otherwise unserializable payload must still reach the agent as
    // *something* rather than taking the call down with a TypeError.
    return String(value);
  }
}

/**
 * Every public operation, in catalog order, as transport-neutral tool specs.
 *
 * No `outputSchema` is advertised, deliberately: MCP requires a server that
 * declares one to return `structuredContent` conforming to it, and these output
 * schemas describe live third-party payloads. One nullable field the model did
 * not anticipate would turn a successful call into a protocol error, so the
 * output shape rides along as documentation (`UpapiToolSpec.outputSchema`)
 * rather than as a contract we would break on someone else's bad day.
 */
export function createUpapiToolSpecs(options: CreateToolsOptions): UpapiToolSpec[] {
  const { caller, filter } = options;
  const ops = filter ? OPERATIONS.filter(filter) : OPERATIONS;

  return ops.map((op) => {
    const execute = async (input: unknown): Promise<unknown> => caller(op.slug, input ?? {});

    const call = async (input: unknown): Promise<ToolCallResult> => {
      try {
        return { content: [{ type: 'text', text: jsonText(await execute(input)) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: formatToolFailure(op.slug, toToolFailure(err)) }],
          isError: true,
        };
      }
    };

    return {
      name: op.operationId,
      slug: op.slug,
      title: op.name,
      description: describe(op),
      summary: op.description,
      category: op.category,
      tags: op.tags,
      unitWeight: op.unitWeight,
      inputSchema: op.inputSchema,
      outputSchema: op.outputSchema,
      annotations: annotationsFor(op),
      execute,
      call,
    };
  });
}

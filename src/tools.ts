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
 * `github-user-emails.get` is the same shape: it reads a person's email
 * addresses off their public commits, and it is categorized `Developer Tools`,
 * so the category filter cannot catch it either.
 */
export const DIRECTORY_EXCLUDED_SLUGS: readonly string[] = [
  'linkedin-profile-search.post',
  'github-user-emails.get',
];

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
 * The six behavioural classes the 95 published operations fall into.
 *
 * `openWorldHint` is `true` in five of the six, and that is not a shortcut: upAPI is
 * an API marketplace, so EVERY published operation exists to reach a system
 * upAPI does not own — GitHub, Reddit, an IMAP host, the Wayback Machine.
 * One candidate for `openWorldHint: false` now exists and is the only one:
 * LOCAL_COMPUTE, whose operation runs entirely inside the worker and reaches no
 * system at all. It was added as its own class below rather than as an exception
 * inside one of the others, which is what the rule here prescribes.
 */

/**
 * A plain lookup: the worker reads a third-party endpoint and writes nothing
 * anywhere. 89 of the 95 published operations.
 *
 * `readOnlyHint` here is derived from what the worker actually DOES, never from
 * the slug's `.get`/`.post` suffix. That suffix names the operation's verb on
 * upAPI's own gateway, not the request the worker makes upstream, and reading it
 * as "writes upstream" would mislabel a dozen pure scrapers — every `.post`
 * operation in this class reaches its upstream with a GET.
 *
 * Verified by grepping every worker under
 * `apps/iii/marketplace-api-worker-{python,ts}/made_by_upapi/` for an outbound
 * POST and intersecting the hits with the published catalog. Two published
 * operations POST upstream to CHANGE something and are classified separately
 * below: `instagram_check_account.py` and `audio_transcribe.py` (job
 * submission). The other POST-ing workers there — account creation, login,
 * comment posting, messaging — are absent from the catalog, so no tool exists
 * for them on any transport.
 *
 * SINCE 2026-09-07 THE HTTP VERB ALONE NO LONGER SEPARATES THOSE TWO SETS. The
 * Wellfound operations speak persisted GraphQL, so every one of them — reads
 * included — is an outbound `POST /graphql`, and the read/write split lives in
 * the OPERATION NAME inside the body (`SeoLandingRoleRemoteSearchPage` reads,
 * `CandidateSendMessage` writes) rather than in the method. A future grep for
 * `session.post` will therefore hit a dozen pure readers; read what the body
 * asks for before reclassifying any of them. Wellfound's three genuine writes
 * (login, apply, send-message) are `publishTargets=[]` and so are absent from
 * the catalog and from this table.
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
 * `wellfound-conversation-detail.post` — opens ONE recruiter thread in the
 * caller's own Wellfound inbox and returns its messages.
 *
 * Not `readOnlyHint: true`, and the reason is an honest gap rather than a
 * measured side effect. A Wellfound conversation carries a server-side `unread`
 * flag, which `wellfound-list-conversations.post` reads back and which the
 * source bot's inbox loop gates on; this is the query Wellfound's own UI fires
 * when a human OPENS a thread, which is exactly the moment a product normally
 * clears that flag. Whether it does could not be settled here: it needs a live
 * account with a genuinely unread thread, and no login was performed for this
 * port. Marking someone's recruiter message read is a real change to their
 * inbox and precisely the class of call a host should confirm rather than
 * auto-run, so the conservative annotation is the honest one until somebody
 * measures it.
 *
 * TO SETTLE IT: list conversations, note an `unread: true` thread, call this
 * operation on it, list again. If `unread` survives, this becomes
 * THIRD_PARTY_READ and this block goes away. Nothing is destroyed either way,
 * and a second identical call leaves the same state, so only `readOnlyHint`
 * is in question.
 *
 * `wellfound-list-conversations.post` stays THIRD_PARTY_READ deliberately:
 * listing threads is not opening one.
 */
const INBOX_THREAD_OPEN: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/**
 * `reddit-oauth-post-comment.post` — publishes a comment to Reddit under the
 * account the caller's OAuth credentials speak as.
 *
 * The first published operation that puts content into the open world under a
 * person's name, so every hint here is the conservative one and none of them is
 * inherited from a neighbour. Not read-only: making the comment exist IS the
 * operation. Not idempotent: Reddit accepts the same text twice and the account
 * is left with two comments, so a client retrying on the strength of an
 * idempotency hint double-posts in public — precisely the failure that hint
 * exists to prevent.
 *
 * `destructiveHint: false` is the narrow, spec-level answer and NOT a claim that
 * the call is harmless: a new comment is ADDITIVE, deleting and overwriting
 * nothing, which is what the field asks. What actually keeps this away from an
 * unattended host is the category — `Social Media` is in
 * DIRECTORY_EXCLUDED_CATEGORIES, so the tool never reaches the listed surface a
 * connector runs from, and the "exactly one listed writer" assertion in
 * __tests__/tools.test.ts still holds. If that category is ever unexcluded, this
 * operation is the first one to look at.
 */
const PUBLIC_POST_WRITE: McpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * `text-analyze.post` — the Rust worker's pure-compute endpoint: counts and a SHA-256
 * over a caller-supplied string.
 *
 * The ONLY published operation with `openWorldHint: false`. Every other tool here
 * reaches a third party whose answer can change between calls; this one touches no
 * network at all, so the same input always yields the same output and a host is free to
 * run it without the "this talks to the internet" caution. Read-only and idempotent for
 * the same reason: there is nothing outside the process for it to change.
 */
const LOCAL_COMPUTE: McpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
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
  // ── Third-party reads (90) ────────────────────────────────────────────────
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
  // The three Chatous reads answer questions about the CALLER'S OWN account, from
  // that account's `connect.sid` cookie: is the session still accepted, what does
  // the account's own profile and conversation list look like, and what has
  // arrived since. They write nothing — no message, no profile edit, no queue
  // entry — and the eight Chatous operations that DO write are absent from the
  // catalog, so no tool exists for them on any transport.
  //
  // Two of them reach Chatous over a SockJS WEBSOCKET rather than an HTTP
  // request, which the class comment above does not cover: its `readOnlyHint`
  // was established by grepping the workers for an outbound POST, and a socket
  // is neither. Checked directly instead. `chatous-get-account-state` and
  // `chatous-poll-events` send exactly ONE frame, `{"type":"init"}` — a
  // subscribe, which is what makes the server push the opening burst these
  // operations read — and then only receive until a bounded message/second
  // budget runs out. `chatous-check-session` is a plain GET.
  //
  // Idempotent in the sense the hint means, on the same terms as the Maps
  // operations above: a repeat call is safe and changes nothing, while the
  // events a poll returns naturally differ between calls because the account's
  // inbox moves underneath it.
  'chatous-check-session.get': THIRD_PARTY_READ,
  'chatous-get-account-state.get': THIRD_PARTY_READ,
  'chatous-poll-events.get': THIRD_PARTY_READ,
  'cloudflare-page-title.get': THIRD_PARTY_READ,
  // The three contra.com reads fetch Contra's own server-rendered public pages
  // anonymously and write nothing: no Contra account is involved, so there is no
  // identity for them to act on. `contra-discover-people.get` reads a directory whose
  // membership Contra reorders, which is the same sense of idempotent the Maps note
  // below sets out — a repeat call is free of side effects, not guaranteed identical.
  'contra-company-profile.get': THIRD_PARTY_READ,
  'contra-discover-people.get': THIRD_PARTY_READ,
  'contra-job-detail.get': THIRD_PARTY_READ,
  'crypto-price.get': THIRD_PARTY_READ,
  'currency-convert.get': THIRD_PARTY_READ,
  'detect-tech-stack.post': THIRD_PARTY_READ,
  'devto-articles-search.get': THIRD_PARTY_READ,
  // The eight `github-*` reads added by the G2 port are plain GETs against
  // api.github.com on the worker's own egress: they read issues, repos, users,
  // contributors, comments and commit-author emails and write nothing. The four
  // GitHub WRITE ops that shipped alongside them (comment, reaction, star,
  // follow) are internal (`publishTargets: []`), so they never reach this union
  // and are deliberately absent — an MCP host cannot invoke them at all.
  'github-issue-comments.get': THIRD_PARTY_READ,
  'github-repo-contributors.get': THIRD_PARTY_READ,
  'github-repo-issues.get': THIRD_PARTY_READ,
  'github-repo.get': THIRD_PARTY_READ,
  'github-search-discussions.get': THIRD_PARTY_READ,
  'github-search-issues.get': THIRD_PARTY_READ,
  'github-search-repos.get': THIRD_PARTY_READ,
  'github-search-users.get': THIRD_PARTY_READ,
  'github-trending.get': THIRD_PARTY_READ,
  'github-user-emails.get': THIRD_PARTY_READ,
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
  // Resolves a numeric pk to a profile. A read on the anonymous private-API
  // surface, which today answers with an identity-only stub (username and picture,
  // no counts) and would answer in full if Instagram widened it; either way the
  // call writes nothing and a repeat is free of side effects, so the annotation
  // does not depend on which of the two answers arrives.
  'instagram-get-user-by-id.post': THIRD_PARTY_READ,
  'instagram-get-user-posts.post': THIRD_PARTY_READ,
  'instagram-get-user-profile.post': THIRD_PARTY_READ,
  'ip-geolocation.get': THIRD_PARTY_READ,
  'linkedin-check-account-health.post': THIRD_PARTY_READ,
  'linkedin-get-profile.post': THIRD_PARTY_READ,
  'linkedin-jobs-detail.get': THIRD_PARTY_READ,
  'linkedin-jobs-search.get': THIRD_PARTY_READ,
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
  // Exchanges the caller's refresh token for a short-lived access token and reads
  // `/api/v1/me` with it. Minting an access token is how an authenticated read
  // authenticates; Reddit does not rotate the refresh token, and nothing on the
  // account is created, so this is a read like its neighbours.
  'reddit-oauth-me.get': THIRD_PARTY_READ,
  'reddit-scrape-post.get': THIRD_PARTY_READ,
  'reddit-search-posts.get': THIRD_PARTY_READ,
  'reddit-subreddit-info.get': THIRD_PARTY_READ,
  'sitemap-parse.get': THIRD_PARTY_READ,
  'stackexchange-search.get': THIRD_PARTY_READ,
  'tiktok-check-account-health.get': THIRD_PARTY_READ,
  'tiktok-discover-users.post': THIRD_PARTY_READ,
  // The three reads added with the TikTok port are the same bargain as the rest of this
  // block: an anonymous GET of a public video, its oEmbed record or a comment's replies.
  // Nothing is posted, no session is spent, and a WAF refusal is reported as a block
  // rather than as a missing record — so a host retrying one changes nothing upstream.
  'tiktok-get-comment-replies.get': THIRD_PARTY_READ,
  'tiktok-get-comments.post': THIRD_PARTY_READ,
  'tiktok-get-user-profile.post': THIRD_PARTY_READ,
  'tiktok-get-video-detail.post': THIRD_PARTY_READ,
  'tiktok-get-video-embed.get': THIRD_PARTY_READ,
  'tiktok-oembed.get': THIRD_PARTY_READ,
  'timezone-lookup.get': THIRD_PARTY_READ,
  'translate-text.get': THIRD_PARTY_READ,
  // Upwork's KEYLESS visitor job surface: an anonymous client_credentials bearer
  // over two read-only GraphQL aliases. No account, no cookie, no browser, and
  // nothing is ever submitted — the authenticated half of Upwork (proposals, DMs,
  // invitations) is deliberately not in upAPI at all.
  'upwork-jobs-detail.get': THIRD_PARTY_READ,
  'upwork-jobs-search.get': THIRD_PARTY_READ,
  'weather-current.get': THIRD_PARTY_READ,
  'web-search.post': THIRD_PARTY_READ,
  // Wellfound reads. Every one is an outbound POST to /graphql because the
  // surface speaks persisted queries; each carries a READ operation name and
  // changes nothing. The five anonymous ones mint or spend a public session;
  // the six session-scoped ones read the caller's OWN account (their searches,
  // their applications, their pipeline, their profile) and write nowhere.
  // wellfound-conversation-detail is the one exception, below.
  'wellfound-application-modal.post': THIRD_PARTY_READ,
  'wellfound-browse-jobs.post': THIRD_PARTY_READ,
  'wellfound-company-overview.post': THIRD_PARTY_READ,
  'wellfound-job-detail.post': THIRD_PARTY_READ,
  'wellfound-list-applications.post': THIRD_PARTY_READ,
  'wellfound-list-conversations.post': THIRD_PARTY_READ,
  'wellfound-pipeline-stats.post': THIRD_PARTY_READ,
  'wellfound-public-session.post': THIRD_PARTY_READ,
  'wellfound-refresh-ops.post': THIRD_PARTY_READ,
  'wellfound-search-jobs.post': THIRD_PARTY_READ,
  'wellfound-viewer.post': THIRD_PARTY_READ,
  'wikipedia-article.get': THIRD_PARTY_READ,

  // ── Mailbox reads, caller-supplied IMAP credentials (2) ───────────────────
  'email-read-verification-code.post': MAILBOX_READ,
  'email-read-verification-link.post': MAILBOX_READ,

  // ── Account-recovery probe (1) ────────────────────────────────────────────
  'instagram-check-account.post': ACCOUNT_RECOVERY_PROBE,

  // ── GPU job submission (1) ────────────────────────────────────────────────
  'audio-transcribe.post': GPU_JOB_SUBMIT,

  // ── Inbox thread open, side effect unmeasured (1) ─────────────────────────
  'wellfound-conversation-detail.post': INBOX_THREAD_OPEN,

  // ── Publishes content under the caller's own account (1) ──────────────────
  'reddit-oauth-post-comment.post': PUBLIC_POST_WRITE,

  // ── Local pure compute, no network (1) ────────────────────────────────────
  'text-analyze.post': LOCAL_COMPUTE,
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

import type { McpToolEntry } from './facade.js';
import type { UpapiToolSpec } from './tools.js';

/**
 * The DIRECTORY tool surface: a curated set of NAMED tools, read tools and
 * write tools kept apart, and every tool carrying its four behavioural hints.
 *
 * This is the third table on the same registry, not a third registry. `compact`
 * (`search_ops` + `call_op`) optimizes for context budget; `full` optimizes for
 * an agent that wants every schema up front; `directory` optimizes for REVIEW —
 * it is the shape an AI marketplace's listing criteria ask for, and the shape a
 * Claude Desktop Extension ships with.
 *
 * Why a third mode rather than reusing `compact`: the Anthropic Connectors
 * review criteria name a catch-all dispatcher with a target parameter as a
 * rejection reason, and `call_op` is exactly that shape — deliberately, because
 * it is the right answer to a 61-operation catalog re-sent on every turn. Both
 * are correct for their audience, so both exist and neither is deleted.
 *
 * Nothing here can widen the surface. Entries are built from the SAME
 * `UpapiToolSpec` objects every other mode lists, so metering, gating, error
 * rendering, and the withheld-category exclusion are byte-identical, and a slug
 * this transport does not serve is simply absent rather than resurrected.
 */

/**
 * The operations a directory listing advertises by name.
 *
 * Curated, not derived: a listing is a promise about what this connector is
 * FOR, and a set that grew itself every time an operation shipped would make
 * that promise on nobody's authority. Chosen as the operations that are (a)
 * differentiated — upAPI runs the browser, the OCR and the Maps HTTP work, so
 * these are not one-line wrappers an agent could write itself — and (b) legible
 * to a reviewer reading tool names alone.
 *
 * Ordered by cluster, and every entry is asserted against the live catalog by
 * `directory.test.ts`: a renamed or retired slug fails the suite instead of
 * quietly shrinking the listing.
 */
export const DIRECTORY_FLAGSHIP_SLUGS: readonly string[] = [
  // Places — the Maps trio, pure-HTTP against Google's own endpoints.
  'google-maps-search.post',
  'google-maps-place.get',
  'google-maps-reviews.get',
  // Open-web retrieval and rendering — the browser-backed operations.
  'web-search.post',
  'fetch-markdown.post',
  'screenshot.post',
  'html-to-pdf.post',
  // Documents and media in, text out.
  'pdf-extract-text.post',
  'image-ocr.post',
  'audio-transcribe.post',
  'audio-transcribe-result.get',
  // Developer lookups.
  'github-repo.get',
  'github-user.get',
  'npm-package.get',
  // Reference data.
  'ip-geolocation.get',
  'wikipedia-article.get',
  'currency-convert.get',
];

/**
 * A directory listing, split on the one hint a host uses to decide whether a
 * call may run unattended.
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
 * The flagship tools this transport can actually serve, partitioned read/write.
 *
 * `specs` is already filtered (directory exclusions, then any host filter), so
 * a flagship slug the transport withholds is absent by construction rather than
 * by re-applying the same rules here and risking a different answer.
 */
export function createDirectoryEntries(specs: readonly UpapiToolSpec[]): DirectoryEntries {
  const bySlug = new Map(specs.map((spec) => [spec.slug, spec]));
  const read: McpToolEntry[] = [];
  const write: McpToolEntry[] = [];

  for (const slug of DIRECTORY_FLAGSHIP_SLUGS) {
    const spec = bySlug.get(slug);
    if (!spec) continue;
    (spec.annotations.readOnlyHint ? read : write).push(spec);
  }

  return { read, write };
}

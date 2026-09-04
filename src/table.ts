import { createDirectoryEntries } from './directory.js';
import { createFacadeEntries, type McpToolEntry } from './facade.js';
import type { UpapiToolSpec } from './tools.js';

/**
 * What `tools/list` ADVERTISES, for every transport and every mode.
 *
 * One function, because the two transports (hosted HTTP, local stdio) must not
 * each grow their own idea of what a mode means. The ACCESS decision is `specs`
 * and is made by the caller before this is reached; everything here is a
 * listing decision, and listing is deliberately narrower than dispatch — see
 * the note on `selectListedTools`.
 */

/**
 * How many tools `tools/list` advertises.
 *
 *  - `compact` — `search_ops` + `call_op` + the always-on operations. A few
 *    kilobytes, flat as the catalog grows, and the shape a hosted client that
 *    re-sends its tool table every turn should use.
 *  - `directory` — a curated set of NAMED tools, reads and writes separated,
 *    every tool annotated. The shape an AI marketplace's listing criteria ask
 *    for and the shape the Claude Desktop Extension ships; see `directory.ts`.
 *  - `full` — one tool per operation, the original table. Kept because an agent
 *    with a large context and a fixed workflow benefits from schemas being
 *    present without a discovery call, and because it is what existing
 *    connections were configured against.
 */
export type McpToolMode = 'compact' | 'directory' | 'full';

const MODES: readonly McpToolMode[] = ['compact', 'directory', 'full'];

/** Narrow an untrusted string to a mode. Unknown values are NOT a mode. */
export function parseToolMode(value: string | null | undefined): McpToolMode | undefined {
  return MODES.find((mode) => mode === value);
}

export type SelectListedToolsOptions = {
  mode: McpToolMode;
  /** Whether this caller may RUN operations. False hides every executable tool. */
  canExecute: boolean;
  /** Whether this caller may SEARCH the catalog. */
  canSearch: boolean;
};

/**
 * The tools to advertise, given the served specs and this caller's grants.
 *
 * Dispatch is deliberately WIDER than this in every mode: an operation that is
 * served but not listed is still callable by name, because the table size is a
 * context-budget and presentation decision, not an access decision. The access
 * decision is `specs` — identical in all three modes — and it is enforced at
 * dispatch, which is why narrowing the listing can never be mistaken for
 * security here.
 */
export function selectListedTools(
  specs: readonly UpapiToolSpec[],
  options: SelectListedToolsOptions,
): McpToolEntry[] {
  const { mode, canExecute, canSearch } = options;
  const { search, call, alwaysOn } = createFacadeEntries(specs);

  if (!canExecute) {
    // Nothing executable may be advertised. Whichever mode was asked for, the
    // search facade is all that is left — listing tools this caller cannot run
    // would cost a tool call to discover the refusal.
    return canSearch ? [search] : [];
  }

  if (mode === 'full') {
    // Exactly the per-op table, with no facade: full mode's premise is that
    // every schema is already present, so a discovery tool is dead weight.
    return [...specs];
  }

  if (mode === 'directory') {
    // Named tools only, reads first. No `call_op`: a catch-all dispatcher with
    // a target parameter is the exact shape directory review criteria reject,
    // and `search_ops` without it would advertise discovery of operations this
    // table does not name. Both stay reachable at dispatch for a client that
    // already knows them — see the note above.
    const { read, write } = createDirectoryEntries(specs);
    return [...read, ...write];
  }

  const listed: McpToolEntry[] = [];
  if (canSearch) listed.push(search);
  listed.push(call, ...alwaysOn);
  return listed;
}

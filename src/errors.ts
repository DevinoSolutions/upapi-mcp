/**
 * Failure translation for MCP tool calls.
 *
 * An operation that fails is NOT a protocol failure: the MCP spec draws a hard
 * line between "the tool ran and reported a problem" (a normal result with
 * `isError: true`, which the model sees and can act on) and "the server broke"
 * (a JSON-RPC error, which the model never sees). Every upAPI failure — a bad
 * argument, a rate limit, an upstream outage — is the first kind. Crashing the
 * transport on a 429 would take out an agent's whole session over a wait.
 */

/** Anything carrying upAPI's public error shape, whatever threw it. */
type ErrorLike = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  retryAfterSeconds?: unknown;
};

export type ToolFailure = {
  code: string;
  message: string;
  status: number | undefined;
  retryAfterSeconds: number | undefined;
};

/**
 * Read a failure structurally rather than by class. `@upapi/sdk`'s `UpAPIError`
 * satisfies this, and so does the hosted route's in-process result — one
 * formatter serves both transports without @upapi/mcp taking a runtime
 * dependency on either one's error type.
 */
export function toToolFailure(err: unknown): ToolFailure {
  const e = (err ?? {}) as ErrorLike;
  const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : 'UNKNOWN';
  const message =
    typeof e.message === 'string' && e.message.length > 0 ? e.message : 'The operation failed.';
  return {
    code,
    message,
    status: typeof e.status === 'number' ? e.status : undefined,
    retryAfterSeconds: typeof e.retryAfterSeconds === 'number' ? e.retryAfterSeconds : undefined,
  };
}

/**
 * The text an agent reads when a tool fails. The error CODE leads because it is
 * the stable thing to branch on (upAPI canonicalizes it across ops and worker
 * languages), and a rate limit spells out the wait in seconds — an agent that is
 * only told "rate limited" retries immediately and burns the next window too.
 */
export function formatToolFailure(slug: string, failure: ToolFailure): string {
  const parts = [`${failure.code}: ${failure.message}`];
  if (failure.retryAfterSeconds !== undefined) {
    parts.push(`Retry after ${failure.retryAfterSeconds} seconds.`);
  }
  parts.push(`(operation: ${slug})`);
  return parts.join(' ');
}

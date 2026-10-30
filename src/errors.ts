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

import type { Denial } from './denial.js';
import { withDefaultNext } from './denial.js';

/** Anything carrying upAPI's public error shape, whatever threw it. */
type ErrorLike = {
  code?: unknown;
  message?: unknown;
  status?: unknown;
  retryAfterSeconds?: unknown;
  next?: unknown;
  docs?: unknown;
};

export type ToolFailure = {
  code: string;
  message: string;
  status: number | undefined;
  retryAfterSeconds: number | undefined;
  next: Denial['next'] | undefined;
  docs: string | undefined;
};

/**
 * Read a failure structurally rather than by class. `@upapi/sdk`'s `UpAPIError`
 * satisfies this, and so does the hosted route's in-process result and a
 * `DenialError` (read through its `.denial`).
 */
export function toToolFailure(err: unknown): ToolFailure {
  const e = (err ?? {}) as ErrorLike & { denial?: ErrorLike };
  const src: ErrorLike = e.denial ?? e;
  const code = typeof src.code === 'string' && src.code.length > 0 ? src.code : 'UNKNOWN';
  const message =
    typeof src.message === 'string' && src.message.length > 0
      ? src.message
      : 'The operation failed.';
  const next =
    src.next && typeof (src.next as { tool?: unknown }).tool === 'string'
      ? (src.next as Denial['next'])
      : undefined;
  return {
    code,
    message,
    status: typeof src.status === 'number' ? src.status : undefined,
    retryAfterSeconds:
      typeof src.retryAfterSeconds === 'number' ? src.retryAfterSeconds : undefined,
    next,
    docs: typeof src.docs === 'string' ? src.docs : undefined,
  };
}

/** The text an agent reads when a tool fails: the denial envelope as JSON. */
export function formatToolFailure(slug: string, failure: ToolFailure): string {
  const d = withDefaultNext({
    code: failure.code,
    message: failure.message,
    ...(failure.next ? { next: failure.next } : {}),
    ...(failure.docs ? { docs: failure.docs } : {}),
    ...(failure.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: failure.retryAfterSeconds }
      : {}),
    operation: slug,
  });
  return JSON.stringify(d);
}

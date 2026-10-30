import type { ToolCallResult } from './tools.js';

export type DenialCode =
  | 'SCOPE_MISSING'
  | 'CONFIRMATION_REQUIRED'
  | 'QUOTA_EXCEEDED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'TOOL_FAILED'
  /** An API key (or any non-human credential) tried a destructive or money-moving action. */
  | 'HUMAN_SESSION_REQUIRED'
  /** The caller's workspace role is too low for this tool (e.g. a member asking for billing). */
  | 'ROLE_REQUIRED'
  /** The tool named a workspace other than the one this credential is bound to. */
  | 'ORG_MISMATCH'
  /** An API key whose creator is no longer a member tried to act through a dashboard route (reads aside). */
  | 'KEY_CREATOR_REQUIRED';

export interface Denial {
  code: DenialCode | (string & {});
  message: string;
  next?: { tool: string; args?: Record<string, unknown> };
  docs?: string;
  retryAfterSeconds?: number;
  operation?: string;
  /** A one-time browser link where the signed-in user can do what this credential may not. */
  handoff?: { url: string; expires_in: number };
}

export class DenialError extends Error {
  constructor(public readonly denial: Denial) {
    super(
      `${denial.code}: ${denial.message}${denial.next ? ' ' + JSON.stringify({ next: denial.next }) : ''}`,
    );
    this.name = 'DenialError';
  }
}

/** Build a denial. A URL in `message` is a programming error (OpenAI app review rejects upsell links in tool output). */
export function denial(
  code: DenialCode,
  message: string,
  next?: Denial['next'],
  docs?: string,
): DenialError {
  if (/https?:\/\//i.test(message)) {
    throw new Error(
      'A denial message must not contain a URL; return it from an explicit tool instead.',
    );
  }
  return new DenialError({
    code,
    message,
    ...(next ? { next } : {}),
    ...(docs ? { docs } : {}),
  });
}

/** The contract's default follow-up for the two codes that always have one. */
export function withDefaultNext(d: Denial): Denial {
  if (d.next) return d;
  if (d.code === 'QUOTA_EXCEEDED') return { ...d, next: { tool: 'upgrade_plan' } };
  if (d.code === 'SCOPE_MISSING') return { ...d, next: { tool: 'request_scopes' } };
  return d;
}

export function renderDenial(d: Denial): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(withDefaultNext(d)) }], isError: true };
}

import { describe, expect, it } from 'vitest';
import { denial, DenialError, renderDenial, withDefaultNext } from '../denial.js';
import { formatToolFailure, toToolFailure } from '../errors.js';

describe('denial envelope', () => {
  it('renders as JSON text with isError', () => {
    const r = renderDenial(denial('NOT_FOUND', 'No such key.', { tool: 'list_api_keys' }).denial);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text)).toEqual({
      code: 'NOT_FOUND',
      message: 'No such key.',
      next: { tool: 'list_api_keys' },
    });
  });
  it('QUOTA_EXCEEDED always points at upgrade_plan, SCOPE_MISSING at request_scopes', () => {
    expect(withDefaultNext({ code: 'QUOTA_EXCEEDED', message: 'm' }).next).toEqual({
      tool: 'upgrade_plan',
    });
    expect(withDefaultNext({ code: 'SCOPE_MISSING', message: 'm' }).next?.tool).toBe(
      'request_scopes',
    );
    expect(withDefaultNext({ code: 'RATE_LIMITED', message: 'm' }).next).toBeUndefined();
  });
  it('an upstream failure keeps the retry wait and the operation, and gains the default next', () => {
    const text = formatToolFailure(
      'web-search.post',
      toToolFailure({
        code: 'QUOTA_EXCEEDED',
        message: 'Monthly quota exceeded: 1000 units/month',
        status: 429,
        retryAfterSeconds: 90,
      }),
    );
    expect(JSON.parse(text)).toEqual({
      code: 'QUOTA_EXCEEDED',
      message: 'Monthly quota exceeded: 1000 units/month',
      next: { tool: 'upgrade_plan' },
      retryAfterSeconds: 90,
      operation: 'web-search.post',
    });
  });
  it('a DenialError thrown by a handler survives toToolFailure', () => {
    const f = toToolFailure(
      new DenialError({
        code: 'CONFIRMATION_REQUIRED',
        message: 'Confirm.',
        next: { tool: 'delete_account', args: { confirmToken: 't' } },
      }),
    );
    expect(f.code).toBe('CONFIRMATION_REQUIRED');
    expect(f.next?.tool).toBe('delete_account');
  });
  it('messages never carry a URL', () => {
    expect(() => denial('TOOL_FAILED', 'see https://example.com')).toThrow(/URL/);
  });
});

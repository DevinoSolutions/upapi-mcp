import { describe, expect, it } from 'vitest';
import { ACCOUNT_TOOL_DEFS } from '../account-tools.js';
import { createUpapiToolSpecs } from '../tools.js';

describe('tools that need a human decision tell the agent to ask first', () => {
  it.each(['upgrade_plan', 'create_api_key', 'invite_member', 'delete_account'])('%s', (name) => {
    const def = ACCOUNT_TOOL_DEFS.find((d) => d.name === name);
    expect(def, name).toBeDefined();
    expect(def!.description, name).toMatch(/Ask the user/);
  });

  it('a public-posting operation says so in its tool description', () => {
    const specs = createUpapiToolSpecs({ caller: async () => ({}) });
    const spec = specs.find((s) => s.slug === 'reddit-oauth-post-comment.post');
    expect(spec, 'reddit-oauth-post-comment.post must be published').toBeDefined();
    expect(spec!.description).toMatch(/Posts publicly/);
    expect(spec!.description).toMatch(/Ask the user to approve the exact text/);
  });

  it('other operations carry no public-write notice', () => {
    const specs = createUpapiToolSpecs({ caller: async () => ({}) });
    const others = specs.filter((s) => s.slug !== 'reddit-oauth-post-comment.post');
    expect(others.some((s) => /Posts publicly/.test(s.description))).toBe(false);
  });
});

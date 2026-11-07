import { describe, expect, it } from 'vitest';
import { ACCOUNT_TOOL_DEFS } from '../account-tools.js';
import { createUpapiToolSpecs } from '../tools.js';

// Operations that put a person's own text into a third party's open world; each carries the notice.
const PUBLIC_POSTING_SLUGS: readonly string[] = [
  'reddit-oauth-post-comment.post',
  'github-issue-comment.post',
];

// Operations that act as the user toward another person and cannot be undone, but are not public
// posts; each carries its own notice telling the agent to get the exact text approved first.
const PERSONAL_SEND_SLUGS: readonly string[] = [
  'wellfound-apply.post',
  'wellfound-send-message.post',
];

describe('tools that need a human decision tell the agent to ask first', () => {
  it.each(['upgrade_plan', 'create_api_key', 'invite_member', 'delete_account'])('%s', (name) => {
    const def = ACCOUNT_TOOL_DEFS.find((d) => d.name === name);
    expect(def, name).toBeDefined();
    expect(def!.description, name).toMatch(/Ask the user/);
  });

  it.each(PUBLIC_POSTING_SLUGS)(
    'a public-posting operation says so in its tool description: %s',
    (slug) => {
      const specs = createUpapiToolSpecs({ caller: async () => ({}) });
      const spec = specs.find((s) => s.slug === slug);
      expect(spec, `${slug} must be published`).toBeDefined();
      expect(spec!.description).toMatch(/Posts publicly/);
      expect(spec!.description).toMatch(/Ask the user to approve the exact text/);
    },
  );

  it('other operations carry no public-write notice', () => {
    const specs = createUpapiToolSpecs({ caller: async () => ({}) });
    const others = specs.filter((s) => !PUBLIC_POSTING_SLUGS.includes(s.slug));
    expect(others.some((s) => /Posts publicly/.test(s.description))).toBe(false);
  });

  it.each(PERSONAL_SEND_SLUGS)('an irreversible send as the user says so: %s', (slug) => {
    const specs = createUpapiToolSpecs({ caller: async () => ({}) });
    const spec = specs.find((s) => s.slug === slug);
    expect(spec, `${slug} must be published`).toBeDefined();
    expect(spec!.description).toMatch(/as the user's Wellfound account/);
    expect(spec!.description).toMatch(/Ask the user to approve the exact/);
  });

  it('the Wellfound login tool tells an agent to prefer an existing session', () => {
    const specs = createUpapiToolSpecs({ caller: async () => ({}) });
    const spec = specs.find((s) => s.slug === 'wellfound-login.post');
    expect(spec, 'wellfound-login.post must be published').toBeDefined();
    expect(spec!.description).toMatch(/Prefer a session the user already holds/);
  });

  it('only the listed operations carry the personal-send notice', () => {
    const specs = createUpapiToolSpecs({ caller: async () => ({}) });
    const others = specs.filter((s) => !PERSONAL_SEND_SLUGS.includes(s.slug));
    expect(others.some((s) => /as the user's Wellfound account/.test(s.description))).toBe(false);
  });
});

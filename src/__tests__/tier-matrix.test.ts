import { describe, expect, it } from 'vitest';
import { createUpapiToolSpecs } from '../tools.js';
import { createFacadeEntries } from '../facade.js';
import { ACCOUNT_TOOL_DEFS } from '../account-tools.js';
import { TIERS } from '../tiers.js';

const caller = async () => ({});

describe('every registered tool has exactly one known tier', () => {
  it('operation tools', () => {
    for (const s of createUpapiToolSpecs({ caller })) expect(TIERS, s.name).toContain(s.tier);
  });
  it('facade tools', () => {
    const { search, call } = createFacadeEntries(createUpapiToolSpecs({ caller }));
    expect(search.tier).toBe('read');
    expect(call.tier).toBe('write');
  });
  it('account tools: unique names, known tiers, annotations agree with tier', () => {
    const names = ACCOUNT_TOOL_DEFS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of ACCOUNT_TOOL_DEFS) {
      expect(TIERS, d.name).toContain(d.tier);
      expect(d.annotations.readOnlyHint, d.name).toBe(d.tier === 'read');
      if (d.tier === 'destructive') expect(d.annotations.destructiveHint, d.name).toBe(true);
    }
  });
  it('hard-to-undo account tools say so in their hints, whatever their tier', () => {
    const byName = new Map(ACCOUNT_TOOL_DEFS.map((d) => [d.name, d]));
    for (const name of [
      'manage_subscription',
      'change_password',
      'remove_push_token',
      'delete_account',
      'update_member_role',
      'remove_member',
      'revoke_invite',
      'revoke_api_key',
      'disconnect',
      'disconnect_platform_account',
      'update_user_api',
      'set_proxy_config',
      'update_hosted_function',
    ]) {
      expect(byName.get(name)?.annotations.destructiveHint, name).toBe(true);
    }
    for (const name of ['invite_member', 'test_proxy_config']) {
      expect(byName.get(name)?.annotations.openWorldHint, name).toBe(true);
    }
    expect(byName.get('billing_status')?.annotations.destructiveHint).toBe(false);
    expect(byName.get('billing_status')?.annotations.openWorldHint).toBe(false);
  });
  it('every contract tier is exercised by at least one account tool', () => {
    const used = new Set(ACCOUNT_TOOL_DEFS.map((d) => d.tier));
    for (const t of TIERS) expect(used.has(t) || t === 'write', t).toBe(true);
  });
});

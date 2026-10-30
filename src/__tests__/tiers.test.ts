import { describe, expect, it } from 'vitest';
import { ALL_TIERS, TIERS, TIER_LABEL, TIER_WARNING, parseTiers } from '../tiers.js';

describe('tiers', () => {
  it('has the nine contract tiers, in order', () => {
    expect([...TIERS]).toEqual([
      'read',
      'write',
      'destructive',
      'billing',
      'account',
      'team',
      'connections',
      'support',
      'keys',
    ]);
  });
  it('labels every tier and warns on the three sensitive ones', () => {
    for (const t of TIERS) expect(TIER_LABEL[t].length).toBeGreaterThan(3);
    expect(Object.keys(TIER_WARNING).sort()).toEqual(['account', 'billing', 'destructive']);
    for (const w of Object.values(TIER_WARNING)) expect(w).not.toMatch(/https?:/i);
  });
  it('parseTiers drops unknown strings and de-duplicates', () => {
    expect(parseTiers(['read', 'bogus', 'read', 'keys'])).toEqual(['read', 'keys']);
    expect(parseTiers('read')).toEqual([]);
    expect(ALL_TIERS.size).toBe(9);
  });
});

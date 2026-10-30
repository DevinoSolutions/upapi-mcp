/**
 * Permission tiers — the same nine names on every Devino app. A leaf module (no
 * imports) so the web app's consent screen, the key picker and this package's
 * tool table can all read it without dragging the MCP SDK along.
 */
export const TIERS = [
  'read',
  'write',
  'destructive',
  'billing',
  'account',
  'team',
  'connections',
  'support',
  'keys',
] as const;
export type Tier = (typeof TIERS)[number];

export const ALL_TIERS: ReadonlySet<Tier> = new Set(TIERS);

/**
 * The tiers that only run and read catalog operations. This is what a connection with NO recorded
 * tier choice gets, and what a legacy unscoped API key (`['*']` or `[]`) maps to: account powers
 * (billing, team, keys, deletion, ...) are always an explicit, recorded opt-in, never a default.
 */
export const OPERATION_TIERS: ReadonlySet<Tier> = new Set<Tier>(['read', 'write']);

export const TIER_LABEL: Record<Tier, string> = {
  read: 'Read your data',
  write: 'Create and edit',
  destructive: 'Delete, publish or send',
  billing: 'Billing and subscription',
  account: 'Profile, preferences, account deletion',
  team: 'Members and invites',
  connections: 'Connected services',
  support: 'Support tickets',
  keys: 'API keys',
};

export const TIER_WARNING: Partial<Record<Tier, string>> = {
  destructive:
    'Can delete or publish data. We keep backups — contact support to restore anything removed by mistake.',
  billing: 'Can start a purchase, cancel or refund your subscription.',
  account: 'Can delete this account. We keep backups — contact support to restore it.',
};

/** Narrow untrusted input to known tiers, de-duplicated, in input order. */
export function parseTiers(value: unknown): Tier[] {
  if (!Array.isArray(value)) return [];
  const out: Tier[] = [];
  for (const v of value) {
    if (
      typeof v === 'string' &&
      (TIERS as readonly string[]).includes(v) &&
      !out.includes(v as Tier)
    ) {
      out.push(v as Tier);
    }
  }
  return out;
}

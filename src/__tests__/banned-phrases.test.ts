import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package-local half of the "never send the user to the app" check (the repo-wide half lives in
 * scripts/__tests__/agent-surfaces-banned-phrases.test.ts). It runs with this package's own tests, so
 * a tool description cannot regress even when only this package is built.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNED = [
  /in the (app|dashboard|ui|web app|studio)\b/i,
  /via the (ui|dashboard)/i,
  /not available (via|through) mcp/i,
  /requires the app/i,
  /cannot be done/i,
  /must be (done|created|edited) (by|in)/i,
  /only from a signed-in session/i,
  /from the dashboard/i,
  /serves 63/i,
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') sources(full, out);
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('tool text never sends the user to the app', () => {
  it.each(sources(SRC).map((f) => [path.relative(SRC, f), f] as const))('%s', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    for (const re of BANNED) expect(text, String(re)).not.toMatch(re);
  });
});

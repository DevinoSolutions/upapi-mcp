import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../meta.js';

/**
 * `server.json` is what the MCP Registry stores, and the registry validates it
 * against the npm publish rather than against this repo — so a drift here does
 * not fail until someone dispatches a release and reads a rejection they cannot
 * explain. Three separate versions of this package's identity existed at once
 * before this file: package.json said 0.1.3, server.json said 0.1.1, and the
 * version an MCP client saw in `initialize` said 0.1.0.
 *
 * The staging step in `scripts/mirror-public-packages.mjs` rewrites
 * server.json's versions from package.json, so the committed file being wrong
 * was invisible. It is still wrong to commit a lie, and `icons` — which the
 * mirror does NOT synthesize — proves the file is read by humans too.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;

const pkg = readJson('package.json');
const server = readJson('server.json');

// Guards the relative-path arithmetic above rather than silently reading {}.
it('found the package root', () => {
  expect(here).toContain('mcp');
  expect(pkg['name']).toBe('@upapi/mcp');
});

describe('one version, three files', () => {
  it('server.json names the package version', () => {
    expect(server['version']).toBe(pkg['version']);
  });

  it('the npm package entry names the package version', () => {
    const packages = server['packages'] as Array<Record<string, unknown>>;
    const npm = packages.find((entry) => entry['identifier'] === pkg['name']);
    expect(npm).toBeDefined();
    expect(npm?.['version']).toBe(pkg['version']);
  });

  it('the version an MCP client sees is the package version', () => {
    expect(SERVER_VERSION).toBe(pkg['version']);
  });
});

describe('registry ownership + listing fields', () => {
  it('server.json name matches package.json mcpName, case included', () => {
    // The registry validates ownership by finding this exact string inside the
    // PUBLISHED package.json. 0.1.1 shipped it lowercased and did not match.
    expect(server['name']).toBe(pkg['mcpName']);
    expect(server['name']).toBe('io.github.DevinoSolutions/upapi-mcp');
  });

  it('keeps description and title inside the schema’s 100-character cap', () => {
    expect(String(server['description']).length).toBeLessThanOrEqual(100);
    expect(String(server['title']).length).toBeLessThanOrEqual(100);
  });

  it('declares icons, each an https URL with an allowed mime type', () => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
    const icons = server['icons'] as Array<Record<string, unknown>> | undefined;
    expect(icons?.length).toBeGreaterThan(0);
    for (const icon of icons ?? []) {
      const src = String(icon['src']);
      expect(src.startsWith('https://'), src).toBe(true);
      expect(src.length, src).toBeLessThanOrEqual(255);
      expect(allowed, src).toContain(icon['mimeType']);
      for (const size of (icon['sizes'] as string[] | undefined) ?? []) {
        expect(size, src).toMatch(/^(\d+x\d+|any)$/);
      }
      if (icon['theme'] !== undefined) expect(['light', 'dark']).toContain(icon['theme']);
    }
  });
});

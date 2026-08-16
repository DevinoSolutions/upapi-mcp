import { defineConfig } from 'vitest/config';

// Standalone mirror of the monorepo config. Upstream this file aliases workspace
// siblings to their TypeScript sources for a hermetic run; here those siblings are
// installed packages, so resolution is left to node_modules.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});

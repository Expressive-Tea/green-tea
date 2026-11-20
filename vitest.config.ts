import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/deno/** holds Deno.test files run separately via `npm run test:deno`;
    // they use `npm:`/`jsr:` specifiers vitest can't resolve.
    exclude: [...configDefaults.exclude, 'test/deno/**', 'test/bun/**', 'test/edge/**'],
    // Test servers bind 127.0.0.1, so no other socket can share their port (#59).
    setupFiles: ['test/setup/loopback.ts'],
    // Node only: Deno, Bun and edge suites run outside vitest. Reported, not gated (#79).
    coverage: { provider: 'v8', include: ['src/**/*.ts'], reporter: ['text-summary', 'json-summary'] },
  },
});

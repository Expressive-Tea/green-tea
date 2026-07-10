import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/deno/** holds Deno.test files run separately via `npm run test:deno`;
    // they use `npm:`/`jsr:` specifiers vitest can't resolve.
    exclude: [...configDefaults.exclude, 'test/deno/**', 'test/bun/**'],
  },
});

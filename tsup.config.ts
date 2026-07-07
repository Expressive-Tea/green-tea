import { defineConfig } from 'tsup';

// Dual build: CJS (dist/index.js) + ESM (dist/index.mjs) + type declarations, from one entry.
// tsup injects a createRequire shim into the ESM output so the lazy require('ws') / require('busboy')
// (optional peer deps) keep working there. reflect-metadata and the peer deps stay external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node18',
  // Give the ESM output a real `require` (via createRequire) so the lazy require('ws') / require('busboy')
  // (optional peer deps) resolve instead of hitting esbuild's "Dynamic require not supported" stub.
  esbuildOptions(options, context) {
    if (context.format === 'esm') {
      options.banner = {
        js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);",
      };
    }
  },
});

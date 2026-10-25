import { defineConfig } from 'tsup';

// Dual build: CJS (dist/index.js) + ESM (dist/index.mjs) + type declarations, from one entry.
// tsup injects a createRequire shim into the ESM output so the lazy require('ws') / require('busboy')
// (optional peer deps) keep working there. reflect-metadata and the peer deps stay external.
export default defineConfig({
  entry: ['src/index.ts', 'src/deno.ts', 'src/bun.ts', 'src/edge.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node22',
  // Give the ESM output a real `require` (via createRequire) so the lazy require('ws') / require('busboy')
  // (optional peer deps) resolve instead of hitting esbuild's "Dynamic require not supported" stub.
  // The call is guarded because it runs at module scope: on workerd `import.meta.url` is not a file
  // URL and `createRequire` throws, which failed the whole worker at load (#93). `require` is then
  // undefined, and src/node-require.ts falls back to `process.getBuiltinModule` or reports the miss
  // in its callers' own terms. The static `node:module` import stays: edge already needs
  // `nodejs_compat`, which provides it, and Node 22.0-22.2 have no `getBuiltinModule` to replace it.
  esbuildOptions(options, context) {
    if (context.format === 'esm') {
      options.banner = {
        js: "import { createRequire as _createRequire } from 'node:module'; const require = (() => { try { return _createRequire(import.meta.url); } catch { return undefined; } })();",
      };
    }
  },
});

// src/node-require.ts — one `require` that survives being published as source.

type Require = <T>(id: string) => T;

interface NodeProcess {
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

let cached: Require | null | undefined;

function resolveRequire(): Require | undefined {
  // The CJS build has a native one, and tsup gives the ESM build one through a `createRequire`
  // banner (tsup.config.ts). Both npm paths stop here.
  if (typeof require === 'function') return require as Require;

  // JSR publishes `src/` and runs no bundler, so on that path nothing ever defined `require`.
  // `process.getBuiltinModule` is the way back: Node 22.3+, Deno and Bun all expose it, and all
  // three do it *synchronously* — which is the whole requirement, since every caller here sits on
  // a sync path that a dynamic `import()` could not serve.
  const proc = (globalThis as { process?: NodeProcess }).process;
  const nodeModule = proc?.getBuiltinModule?.('node:module') as
    { createRequire?: (from: string) => Require } | undefined;
  if (!nodeModule?.createRequire || !proc?.cwd) return undefined;

  // Resolve from the application's directory rather than from this file: served from JSR this
  // module lives under an `https://` URL with no `node_modules` beneath it, while an optional peer
  // dependency such as `busboy` is installed in the app that asked for it.
  return nodeModule.createRequire(`${proc.cwd()}/`);
}

/**
 * Loads a Node builtin or an installed package, synchronously.
 *
 * Throws on a runtime that can offer neither — workerd, where `node:fs` and `busboy` are genuinely
 * out of reach. Every caller already guards for that and reports it in its own terms; what they
 * must not do is report it when the module is in fact reachable, which is what a bare `require`
 * caused on JSR by failing with `ReferenceError` before any of them was consulted.
 */
export function nodeRequire<T>(id: string): T {
  if (cached === undefined) cached = resolveRequire() ?? null;
  if (cached === null) throw new Error(`cannot load '${id}': this runtime provides no CommonJS require`);
  return cached<T>(id);
}

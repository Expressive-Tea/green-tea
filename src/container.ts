/** Lifetime of a binding: `app` values are memoized for the process, `request` values are recomputed per resolve. */
export type Scope = 'app' | 'request';
/** Produces a bound value from the current context; may be async. */
export type Factory = (ctx: Record<string, unknown>) => unknown | Promise<unknown>;

interface Binding {
  scope: Scope;
  factory: Factory;
  /** The app-scoped value, cached as a promise from the moment the factory starts. */
  cached?: Promise<unknown>;
}

/** Minimal token-keyed dependency container with app-scoped memoization and async, mesh-ready resolution. */
export class Container {
  private readonly bindings = new Map<string, Binding>();

  /** Bind `token` to `factory` under `scope`, replacing any existing binding. */
  register(token: string, scope: Scope, factory: Factory): void {
    this.bindings.set(token, { scope, factory });
  }

  /** Whether `token` currently has a binding. */
  has(token: string): boolean {
    return this.bindings.has(token);
  }

  /** Resolve `token`'s value; app-scoped results are cached, request-scoped ones re-run the factory. Throws on unknown tokens. */
  // ponytail: app-scope memoizes; request-scope always re-runs. resolve is async
  // so a future remote transport (mesh) slots in without changing callers.
  async resolve(token: string, ctx: Record<string, unknown> = {}): Promise<unknown> {
    const binding = this.bindings.get(token);
    if (!binding) throw new Error(`unknown token: ${token}`);
    if (binding.scope === 'request') return binding.factory(ctx);
    if (binding.cached) return binding.cached;

    // The pending promise is cached, not the settled value (GitHub #46): a resolve that starts
    // while the factory is still running must wait for it, or it runs the factory a second time.
    // A rejection is not kept — it clears the cache, so the next resolve retries, as it did when
    // only successes were cached. The async wrapper turns a synchronous throw into that rejection.
    const pending = (async () => binding.factory(ctx))();
    binding.cached = pending;
    pending.catch(() => {
      if (binding.cached === pending) binding.cached = undefined;
    });
    return pending;
  }
}

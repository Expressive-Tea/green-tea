export type Scope = 'app' | 'request';
export type Factory = (ctx: Record<string, unknown>) => unknown | Promise<unknown>;

interface Binding { scope: Scope; factory: Factory; cached?: unknown; resolved?: boolean }

export class Container {
  private readonly bindings = new Map<string, Binding>();

  register(token: string, scope: Scope, factory: Factory): void {
    this.bindings.set(token, { scope, factory });
  }

  has(token: string): boolean {
    return this.bindings.has(token);
  }

  // ponytail: app-scope memoizes; request-scope always re-runs. resolve is async
  // so a future remote transport (mesh) slots in without changing callers.
  async resolve(token: string, ctx: Record<string, unknown> = {}): Promise<unknown> {
    const b = this.bindings.get(token);
    if (!b) throw new Error(`unknown token: ${token}`);
    if (b.scope === 'app' && b.resolved) return b.cached;
    const value = await b.factory(ctx);
    if (b.scope === 'app') { b.cached = value; b.resolved = true; }
    return value;
  }
}

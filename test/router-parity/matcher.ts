/**
 * The differential matcher harness: one ordered declaration array and one request list, run through
 * any implementation of the router's lookup functions, reduced to what a caller can observe —
 * which declaration answered (by stable ID, never by pattern text), its decoded params, whether HEAD
 * was implicit, the ordered `Allow` list, and the normalization error if the path never got that far.
 */
import type { RouteDef } from '../../src/http/types';

export type Transport = 'buffer' | 'sse' | 'ndjson' | 'negotiate';

export interface Declaration {
  id: string;
  method: string;
  pattern: string;
  transport: Transport;
}

export interface Request {
  method: string;
  raw: string;
}

export interface Scenario {
  id: string;
  note: string;
  declarations: Declaration[];
  requests: Request[];
}

/** The lookup surface CARD-07 replaces. The live router and the frozen oracle both satisfy it. */
export interface MatcherImpl {
  normalizeRequestPath(path: string): string;
  matchRoute(
    routes: RouteDef[],
    method: string,
    path: string,
  ): { def: unknown; params: Record<string, string> } | undefined;
  resolveRoute(
    routes: RouteDef[],
    method: string,
    path: string,
  ): { def: unknown; params: Record<string, string>; implicitHead: boolean } | undefined;
  allowedMethods(routes: RouteDef[], path: string): string[];
}

export interface ErrorOutcome {
  name: string;
  message: string;
}

export interface Outcome {
  method: string;
  raw: string;
  normalized?: string;
  error?: ErrorOutcome;
  match?: { id: string; params: Record<string, string> } | null;
  resolve?: { id: string; params: Record<string, string>; implicitHead: boolean } | null;
  allow?: string[];
}

export function errorOutcome(error: unknown): ErrorOutcome {
  const err = error as Error;
  return { name: err.name, message: err.message };
}

/** Builds fresh `RouteDef` objects for one run, so no implementation can see another's cached table. */
function buildRoutes(declarations: Declaration[]): { routes: RouteDef[]; idOf: Map<unknown, string> } {
  const idOf = new Map<unknown, string>();
  const routes = declarations.map((decl): RouteDef => {
    const def: RouteDef = {
      method: decl.method,
      pattern: decl.pattern,
      transport: decl.transport,
      handler: async () => ({ status: 200, headers: {}, body: decl.id }),
    };
    idOf.set(def, decl.id);
    return def;
  });
  return { routes, idOf };
}

export function runScenario(impl: MatcherImpl, scenario: Scenario): Outcome[] {
  const { routes, idOf } = buildRoutes(scenario.declarations);
  const id = (def: unknown): string => idOf.get(def) ?? '<unknown declaration>';

  return scenario.requests.map(({ method, raw }): Outcome => {
    let normalized: string;

    try {
      normalized = impl.normalizeRequestPath(raw);
    } catch (error) {
      return { method, raw, error: errorOutcome(error) };
    }

    const match = impl.matchRoute(routes, method, normalized);
    const resolved = impl.resolveRoute(routes, method, normalized);

    return {
      method,
      raw,
      normalized,
      match: match ? { id: id(match.def), params: match.params } : null,
      resolve: resolved ? { id: id(resolved.def), params: resolved.params, implicitHead: resolved.implicitHead } : null,
      allow: impl.allowedMethods(routes, normalized),
    };
  });
}

/** Serialized request context sent across the mesh for a scope or route RPC. */
export interface RequestEnvelope {
  method: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** Manifest entry for an exported scope token and its lifetime. */
export interface ScopeEntry {
  token: string;
  scope: 'app' | 'request';
}
/** Manifest entry for an exported route. */
export interface RouteEntry {
  method: string;
  pattern: string;
}
/** A mesh server's advertised scopes and routes. */
export interface Manifest {
  scopes: ScopeEntry[];
  routes: RouteEntry[];
}

/** Discriminated union of every message on the mesh wire. */
export type Frame =
  | { type: 'hello'; secret: string }
  | { type: 'manifest'; scopes: ScopeEntry[]; routes: RouteEntry[] }
  | { type: 'rpc-req'; id: string; kind: 'scope' | 'route'; name: string; ctx: RequestEnvelope }
  | { type: 'rpc-res'; id: string; ok: true; result: unknown }
  | { type: 'rpc-res'; id: string; ok: false; error: { message: string; status?: number } };

const TYPES = new Set(['hello', 'manifest', 'rpc-req', 'rpc-res']);

/** Serialize a frame to a JSON wire string. */
export function encode(frame: Frame): string {
  return JSON.stringify(frame);
}

/** Parse a wire string into a frame, throwing if the `type` tag is unknown. */
export function decode(json: string): Frame {
  const parsed = JSON.parse(json) as { type?: unknown };

  if (typeof parsed.type !== 'string' || !TYPES.has(parsed.type)) {
    throw new Error(`unknown frame type: ${String(parsed.type)}`);
  }

  return parsed as Frame;
}

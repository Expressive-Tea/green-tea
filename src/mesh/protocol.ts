export interface RequestEnvelope {
  method: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export interface ScopeEntry { token: string; scope: 'app' | 'request' }
export interface RouteEntry { method: string; pattern: string }
export interface Manifest { scopes: ScopeEntry[]; routes: RouteEntry[] }

export type Frame =
  | { type: 'hello'; secret: string }
  | { type: 'manifest'; scopes: ScopeEntry[]; routes: RouteEntry[] }
  | { type: 'rpc-req'; id: string; kind: 'scope' | 'route'; name: string; ctx: RequestEnvelope }
  | { type: 'rpc-res'; id: string; ok: true; result: unknown }
  | { type: 'rpc-res'; id: string; ok: false; error: { message: string; status?: number } };

const TYPES = new Set(['hello', 'manifest', 'rpc-req', 'rpc-res']);

export function encode(f: Frame): string {
  return JSON.stringify(f);
}

export function decode(s: string): Frame {
  const f = JSON.parse(s) as { type?: unknown };
  if (typeof f.type !== 'string' || !TYPES.has(f.type)) {
    throw new Error(`unknown frame type: ${String(f.type)}`);
  }
  return f as Frame;
}

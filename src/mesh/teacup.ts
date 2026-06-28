import type { Link } from './link';
import type { RequestEnvelope } from './protocol';
import type { ResponseShape } from '../pipeline';

export interface RemoteScopeNode { name: string; run: (ctx: any) => Promise<Record<string, unknown>> }
export interface RemoteRoute { method: string; pattern: string; handler: (req: RequestEnvelope) => Promise<ResponseShape> }

export function envelopeFrom(ctx: any): RequestEnvelope {
  return {
    method: ctx?.req?.method ?? ctx?.method ?? 'GET',
    params: ctx?.params ?? {},
    query: ctx?.query ?? {},
    body: ctx?.body,
    headers: ctx?.headers ?? {},
  };
}

export function buildRemote(link: Link, origin: string): {
  providers: RemoteScopeNode[]; steps: RemoteScopeNode[]; routes: RemoteRoute[];
} {
  const providers: RemoteScopeNode[] = [];
  const steps: RemoteScopeNode[] = [];
  for (const s of link.manifest.scopes) {
    const node: RemoteScopeNode = {
      name: s.token,
      run: async (ctx: any) => ({ [s.token]: await link.rpc('scope', s.token, envelopeFrom(ctx)) }),
    };
    (s.scope === 'app' ? providers : steps).push(node);
  }
  const routes: RemoteRoute[] = link.manifest.routes.map((r) => ({
    method: r.method, pattern: r.pattern,
    handler: async (req: RequestEnvelope) => (await link.rpc('route', r.pattern, req)) as ResponseShape,
  }));
  return { providers, steps, routes };
}

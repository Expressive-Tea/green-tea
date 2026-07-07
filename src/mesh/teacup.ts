import type { Link } from './link';
import type { RequestEnvelope } from './protocol';
import type { ResponseShape } from '../pipeline';

/** Local proxy for a remote scope: runs the RPC and returns its token→value binding. */
export interface RemoteScopeNode {
  name: string;
  run: (ctx: any) => Promise<Record<string, unknown>>;
}
/** Local proxy for a remote route: forwards the request envelope over the link. */
export interface RemoteRoute {
  method: string;
  pattern: string;
  handler: (req: RequestEnvelope) => Promise<ResponseShape>;
}

/** Extract a {@link RequestEnvelope} from a local request context for transmission over the mesh. */
export function envelopeFrom(ctx: any): RequestEnvelope {
  return {
    method: ctx?.req?.method ?? ctx?.method ?? 'GET',
    params: ctx?.params ?? {},
    query: ctx?.query ?? {},
    body: ctx?.body,
    headers: ctx?.headers ?? {},
  };
}

/** Turn a link's manifest into local proxy nodes: app-scope providers, request-scope steps, and routes. */
export function buildRemote(link: Link): {
  providers: RemoteScopeNode[];
  steps: RemoteScopeNode[];
  routes: RemoteRoute[];
} {
  const providers: RemoteScopeNode[] = [];
  const steps: RemoteScopeNode[] = [];

  for (const scope of link.manifest.scopes) {
    const node: RemoteScopeNode = {
      name: scope.token,
      run: async (ctx: any) => ({ [scope.token]: await link.rpc('scope', scope.token, envelopeFrom(ctx)) }),
    };
    (scope.scope === 'app' ? providers : steps).push(node);
  }

  const routes: RemoteRoute[] = link.manifest.routes.map((route) => ({
    method: route.method,
    pattern: route.pattern,
    handler: async (req: RequestEnvelope) => (await link.rpc('route', route.pattern, req)) as ResponseShape,
  }));
  return { providers, steps, routes };
}

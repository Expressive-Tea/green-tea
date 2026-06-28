import crypto from 'crypto';
import type { Bus } from '../bus';
import type { ResponseShape } from '../pipeline';
import { isHttpError } from '../signals';
import { encode, decode, type Manifest, type RequestEnvelope, type RouteEntry, type Frame } from './protocol';

export const MESH_CONTROL_PATH = '/__mesh__/control';

export function buildManifest(args: {
  providers: string[];        // exported provider tokens (app-scope)
  steps: string[];            // exported step tokens (request-scope)
  routes: RouteEntry[];       // exported buffered routes
}): Manifest {
  return {
    scopes: [
      ...args.providers.map((token) => ({ token, scope: 'app' as const })),
      ...args.steps.map((token) => ({ token, scope: 'request' as const })),
    ],
    routes: args.routes,
  };
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export interface MeshControlDeps {
  secret: string;
  manifest: Manifest;
  resolveScope: (name: string, env: RequestEnvelope) => Promise<unknown>;
  resolveRoute: (name: string, env: RequestEnvelope) => Promise<ResponseShape>;
  bus?: Bus;
}

export function createMeshControl(deps: MeshControlDeps): { path: string; handle: (ws: any) => void } {
  const exportedScopes = new Set(deps.manifest.scopes.map((s) => s.token));
  const exportedRoutes = new Set(deps.manifest.routes.map((r) => `${r.method} ${r.pattern}`));

  return {
    path: MESH_CONTROL_PATH,
    handle(ws: any) {
      let authed = false;
      ws.on('message', async (data: unknown) => {
        let frame: Frame;
        try { frame = decode(String(data)); } catch { return; }

        if (!authed) {
          if (frame.type === 'hello' && safeEqual(frame.secret, deps.secret)) {
            authed = true;
            ws.send(encode({ type: 'manifest', scopes: deps.manifest.scopes, routes: deps.manifest.routes }));
            deps.bus?.emit('mesh:connect', { name: 'teapot' });
          } else {
            ws.close(1008);
          }
          return;
        }

        if (frame.type !== 'rpc-req') return;
        const { id, kind, name, ctx } = frame;
        try {
          let result: unknown;
          if (kind === 'scope') {
            if (!exportedScopes.has(name)) { const e: any = new Error(`not exported: ${name}`); e.status = 403; throw e; }
            result = await deps.resolveScope(name, ctx);
          } else {
            if (![...exportedRoutes].some((k) => k.endsWith(` ${name}`))) { const e: any = new Error(`not exported: ${name}`); e.status = 403; throw e; }
            result = await deps.resolveRoute(name, ctx);
          }
          ws.send(encode({ type: 'rpc-res', id, ok: true, result }));
        } catch (err) {
          const status = isHttpError(err) ? err.status : (err as any)?.status ?? 500;
          deps.bus?.emit('mesh:rpc:error', { name, error: err });
          ws.send(encode({ type: 'rpc-res', id, ok: false, error: { message: (err as Error).message, status } }));
        }
      });
      ws.on('close', () => deps.bus?.emit('mesh:disconnect', { name: 'teapot' }));
    },
  };
}

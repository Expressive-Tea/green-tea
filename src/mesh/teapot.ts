import crypto from 'crypto';
import type { Bus } from '../bus';
import type { ResponseShape } from '../pipeline';
import { isHttpError } from '../signals';
import {
  encode,
  decode,
  MESH_PROTOCOL_VERSION,
  type Manifest,
  type RequestEnvelope,
  type RouteEntry,
  type Frame,
} from './protocol';

/** WebSocket path where a teapot exposes its mesh control channel. */
export const MESH_CONTROL_PATH = '/__mesh__/control';

/** Assemble a {@link Manifest} from exported provider/step tokens and buffered routes. */
export function buildManifest(args: {
  providers: string[]; // exported provider tokens (app-scope)
  steps: string[]; // exported step tokens (request-scope)
  routes: RouteEntry[]; // exported buffered routes
}): Manifest {
  return {
    scopes: [
      ...args.providers.map((token) => ({ token, scope: 'app' as const })),
      ...args.steps.map((token) => ({ token, scope: 'request' as const })),
    ],
    routes: args.routes,
  };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

/** Dependencies for the mesh control handler: shared secret, manifest, and scope/route resolvers. */
export interface MeshControlDeps {
  secret: string;
  manifest: Manifest;
  resolveScope: (name: string, env: RequestEnvelope) => Promise<unknown>;
  resolveRoute: (name: string, env: RequestEnvelope) => Promise<ResponseShape>;
  bus?: Bus;
}

/** The rpc-req member of the {@link Frame} union. */
type RpcReqFrame = Extract<Frame, { type: 'rpc-req' }>;

/** Build a 403 "not exported" error for an unknown scope/route token. */
function notExported(name: string): Error {
  const error: any = new Error(`not exported: ${name}`);
  error.status = 403;

  return error;
}

/**
 * Validate an unauthenticated hello frame; reply with the manifest on success or close on mismatch.
 * The version is checked *before* the secret: a skewed peer is not an auth failure, and telling it
 * "wrong secret" would send its operator hunting the wrong bug.
 */
function handleHandshake(ws: any, frame: Frame, deps: MeshControlDeps): boolean {
  if (frame.type !== 'hello') {
    ws.close(1008);

    return false;
  }

  if (frame.v !== MESH_PROTOCOL_VERSION) {
    ws.close(
      1008,
      `mesh protocol version mismatch: peer speaks v${frame.v}, this teapot speaks v${MESH_PROTOCOL_VERSION}`,
    );

    return false;
  }

  if (!safeEqual(frame.secret, deps.secret)) {
    ws.close(1008);

    return false;
  }

  ws.send(
    encode({
      type: 'manifest',
      v: MESH_PROTOCOL_VERSION,
      scopes: deps.manifest.scopes,
      routes: deps.manifest.routes,
    }),
  );
  deps.bus?.emit('mesh:connect', { name: 'teapot' });

  return true;
}

/** Resolve an authenticated rpc-req against the exported scopes/routes, enforcing export gating. */
function resolveRpc(
  frame: RpcReqFrame,
  deps: MeshControlDeps,
  exportedScopes: Set<string>,
  exportedRoutes: Set<string>,
): Promise<unknown> {
  const { kind, name, ctx } = frame;

  if (kind === 'scope') {
    if (!exportedScopes.has(name)) throw notExported(name);

    return deps.resolveScope(name, ctx);
  }

  if (![...exportedRoutes].some((key) => key.endsWith(` ${name}`))) throw notExported(name);

  return deps.resolveRoute(name, ctx);
}

/** Serve one authenticated rpc-req: resolve it and frame the ok/error response back to the peer. */
async function handleRpc(
  ws: any,
  frame: RpcReqFrame,
  deps: MeshControlDeps,
  exportedScopes: Set<string>,
  exportedRoutes: Set<string>,
): Promise<void> {
  const { id, name } = frame;

  try {
    const result = await resolveRpc(frame, deps, exportedScopes, exportedRoutes);

    ws.send(encode({ type: 'rpc-res', id, ok: true, result }));
  } catch (err) {
    const status = isHttpError(err) ? err.status : ((err as any)?.status ?? 500);

    deps.bus?.emit('mesh:rpc:error', { name, error: err });
    ws.send(encode({ type: 'rpc-res', id, ok: false, error: { message: (err as Error).message, status } }));
  }
}

/** Build a WebSocket handler that authenticates peers and serves scope/route RPCs from the manifest. */
export function createMeshControl(deps: MeshControlDeps): { path: string; handle: (ws: any) => void } {
  const exportedScopes = new Set(deps.manifest.scopes.map((scope) => scope.token));
  const exportedRoutes = new Set(deps.manifest.routes.map((route) => `${route.method} ${route.pattern}`));

  return {
    path: MESH_CONTROL_PATH,
    handle(ws: any) {
      let authed = false;
      ws.on('message', async (data: unknown) => {
        let frame: Frame;

        try {
          frame = decode(String(data));
        } catch {
          return;
        }

        if (!authed) {
          authed = handleHandshake(ws, frame, deps);

          return;
        }

        if (frame.type !== 'rpc-req') return;

        await handleRpc(ws, frame, deps, exportedScopes, exportedRoutes);
      });
      ws.on('close', () => deps.bus?.emit('mesh:disconnect', { name: 'teapot' }));
    },
  };
}

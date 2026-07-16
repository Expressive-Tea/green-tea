// node: prefix, not a bare specifier: this is the mesh auth path, and on Deno/Bun a bare
// 'crypto' leans on node-compat resolution heuristics. Buffer + timingSafeEqual resolve
// under node-compat on both; edge/workerd is out of scope (see the cross-runtime spec).
import crypto from 'node:crypto';
import type { Bus } from '../bus';
import type { WsSocket } from '../http/ws-core';
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
function handleHandshake(socket: WsSocket, frame: Frame, deps: MeshControlDeps): boolean {
  if (frame.type !== 'hello') {
    socket.close(1008);

    return false;
  }

  if (frame.v !== MESH_PROTOCOL_VERSION) {
    socket.close(
      1008,
      `mesh protocol version mismatch: peer speaks v${frame.v}, this teapot speaks v${MESH_PROTOCOL_VERSION}`,
    );

    return false;
  }

  if (!safeEqual(frame.secret, deps.secret)) {
    socket.close(1008);

    return false;
  }

  socket.send(
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
  socket: WsSocket,
  frame: RpcReqFrame,
  deps: MeshControlDeps,
  exportedScopes: Set<string>,
  exportedRoutes: Set<string>,
): Promise<void> {
  const { id, name } = frame;

  try {
    const result = await resolveRpc(frame, deps, exportedScopes, exportedRoutes);

    socket.send(encode({ type: 'rpc-res', id, ok: true, result }));
  } catch (err) {
    const status = isHttpError(err) ? err.status : ((err as any)?.status ?? 500);

    deps.bus?.emit('mesh:rpc:error', { name, error: err });
    socket.send(encode({ type: 'rpc-res', id, ok: false, error: { message: (err as Error).message, status } }));
  }
}

/** Drive one control connection to completion: handshake, then serve RPCs until the socket ends. */
async function serveFrames(
  socket: WsSocket,
  deps: MeshControlDeps,
  exportedScopes: Set<string>,
  exportedRoutes: Set<string>,
): Promise<void> {
  let authed = false;

  try {
    for await (const data of socket.inbound) {
      let frame: Frame;

      try {
        frame = decode(String(data));
      } catch {
        continue; // undecodable frames are ignored, as before
      }

      if (!authed) {
        authed = handleHandshake(socket, frame, deps);
        continue;
      }

      // answered only after the handshake: an unauthenticated peer gets no signal at all
      if (frame.type === 'ping') {
        socket.send(encode({ type: 'pong' }));
        continue;
      }

      if (frame.type !== 'rpc-req') continue;

      // deliberately not awaited: RPCs overlap, exactly as they did under the `ws.on('message')`
      // listener. The id-keyed `pending` map on the peer exists to allow in-flight concurrency —
      // awaiting here would silently serialize every mesh call.
      void handleRpc(socket, frame, deps, exportedScopes, exportedRoutes);
    }
  } catch {
    /* socket failed; the disconnect emit below is the same signal a clean close gives */
  } finally {
    deps.bus?.emit('mesh:disconnect', { name: 'teapot' });
  }
}

/** Build a control handler that authenticates peers and serves scope/route RPCs from the manifest. */
export function createMeshControl(deps: MeshControlDeps): {
  path: string;
  handle: (socket: WsSocket) => Promise<void>;
} {
  const exportedScopes = new Set(deps.manifest.scopes.map((scope) => scope.token));
  const exportedRoutes = new Set(deps.manifest.routes.map((route) => `${route.method} ${route.pattern}`));

  return {
    path: MESH_CONTROL_PATH,
    /**
     * Resolves when the connection ends, mirroring `runWsConnection` — so `app.upgrade` can await
     * the control channel's lifetime the same way it awaits a regular ws route's.
     * `channel` is fan-out and subscribes when the async iterator is created, which `for await`
     * does synchronously, so the loop is live before any frame can arrive.
     */
    handle(socket: WsSocket): Promise<void> {
      return serveFrames(socket, deps, exportedScopes, exportedRoutes);
    },
  };
}

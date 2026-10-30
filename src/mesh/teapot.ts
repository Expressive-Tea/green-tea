// node: prefix, not a bare specifier: this is the mesh auth path, and on Deno/Bun a bare
// 'crypto' leans on node-compat resolution heuristics. Buffer + timingSafeEqual resolve
// under node-compat on both; edge/workerd is out of scope (see the cross-runtime spec).
import crypto from 'node:crypto';
import type { Bus } from '../bus';
import { HELLO_FRAME_BYTES, sendWhenDrained, widenInbound, type WsSocket } from '../http/ws-core';
import type { ResponseShape } from '../pipeline';
import { isHttpError } from '../signals';
import {
  encode,
  decode,
  untransportable,
  MESH_PROTOCOL_VERSION,
  type Manifest,
  type RequestEnvelope,
  type RouteEntry,
  type Frame,
} from './protocol';

/**
 * WebSocket path where a teapot exposes its mesh control channel.
 *
 * Reserved in every app, mesh or not (D17): `createApp` refuses a route that claims it, and an upgrade
 * to it on an app without a control channel closes `1008` on every adapter.
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in a minor release.
 */
export const MESH_CONTROL_PATH = '/__mesh__/control';

/**
 * Close reason for an upgrade to {@link MESH_CONTROL_PATH} on an app with no control channel. One
 * string shared by `app.upgrade` and the Node listener, so every adapter refuses it identically (D17).
 */
export const MESH_CONTROL_DISABLED_REASON =
  'mesh control channel not enabled: this app exports nothing, or has no mesh.secret';

/**
 * How long an unauthenticated peer may hold the control channel open before it is hung up on.
 *
 * The teacup has always bounded its side of the handshake; the teapot had no equivalent, so a peer
 * could connect and simply never send `hello`, holding a socket indefinitely without proving
 * anything. Generous on purpose — this is a deadline against silence, not a latency budget.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** `limits.maxBodyBytes`'s default, which a teapot without one is sized for. */
const DEFAULT_MAX_BODY_BYTES = 1_000_000;

/**
 * The most a body byte can grow inside an `rpc-req` envelope. The envelope is JSON, and a text
 * body travels as a JSON string, so a control character (`\u0001`) becomes the six characters of its
 * escape. Nothing a body can hold grows more: a `"` or backslash doubles, a JSON number such as
 * `1e20` re-encodes to about five times its length, a multipart `Buffer` to at most four, and
 * non-ASCII text is not escaped at all.
 */
const WORST_ESCAPE = 6;

/** Room in a frame for everything but the body: headers, params, query, url and the envelope. */
const ENVELOPE_HEADROOM = 1_048_576;

/**
 * Largest control frame a teapot accepts, in characters, when the largest body it may be sent is
 * `maxBodyBytes` (#120): the body at its worst escaping plus {@link ENVELOPE_HEADROOM}, so any body
 * within the limit fits. 7,048,576 at the 1 MB default.
 *
 * `decode` runs `JSON.parse` on peer-controlled input, so the parse is capped by this figure — and
 * an unauthenticated peer never gets near it: until its `hello` is accepted, the channel takes only
 * hello-sized frames (`HELLO_FRAME_BYTES`, `controlBounds` in `ws-core`). Applies to the control
 * channel only: user WebSocket routes keep `limits.maxWsMessageBytes`.
 */
export function controlFrameLimit(maxBodyBytes = DEFAULT_MAX_BODY_BYTES): number {
  return WORST_ESCAPE * maxBodyBytes + ENVELOPE_HEADROOM;
}

/**
 * Assemble a {@link Manifest} from exported step tokens and buffered routes.
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in a minor release.
 */
export function buildManifest(args: { steps: string[]; routes: RouteEntry[] }): Manifest {
  return { steps: [...args.steps], routes: args.routes };
}

function safeEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

/**
 * Dependencies for the mesh control handler: shared secret, manifest, and scope/route resolvers.
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in a minor release.
 */
export interface MeshControlDeps {
  secret: string;
  manifest: Manifest;
  resolveScope: (name: string, env: RequestEnvelope) => Promise<unknown>;
  resolveRoute: (name: string, env: RequestEnvelope) => Promise<ResponseShape>;
  bus?: Bus;
  /**
   * The largest request body this teapot accepts, which sizes the control frames it parses
   * ({@link controlFrameLimit}). Defaults to the 1 MB body default.
   */
  maxBodyBytes?: number;
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

  // The peer holds the secret now: lift the hello-sized bounds its socket was given to the ones
  // that carry RPC bodies (#120, #148). A socket bounded without a second phase is left as it is.
  widenInbound(socket);
  socket.send(
    encode({
      type: 'manifest',
      v: MESH_PROTOCOL_VERSION,
      steps: deps.manifest.steps,
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

/**
 * Sends one frame once the socket has room (#41): RPCs are served concurrently, so without the wait
 * a peer that stops reading grows the send buffer by one response per request it keeps sending.
 */
function reply(socket: WsSocket, frame: Frame): Promise<void> {
  return sendWhenDrained(socket, () => encode(frame));
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
    // Checked here, on the side that still holds the real value. Past `encode` the evidence is
    // gone: JSON turns a pool into `{}`, which arrives looking alive and fails at the call site.
    const offender = untransportable(result);

    if (offender) {
      const error: any = new Error(
        `mesh cannot transport '${name}': ${offender.path} is ${offender.what}. ` +
          'The wire is JSON, so a mesh export carries data, never behaviour — export what the ' +
          'handle produces rather than the handle.',
      );
      error.status = 500;
      throw error;
    }

    await reply(socket, { type: 'rpc-res', id, ok: true, result });
  } catch (err) {
    const status = isHttpError(err) ? err.status : ((err as any)?.status ?? 500);

    deps.bus?.emit('mesh:rpc:error', { name, error: err });
    await reply(socket, { type: 'rpc-res', id, ok: false, error: { message: (err as Error).message, status } });
  }
}

/** Drive one control connection to completion: handshake, then serve RPCs until the socket ends. */
async function serveFrames(
  socket: WsSocket,
  deps: MeshControlDeps,
  exportedScopes: Set<string>,
  exportedRoutes: Set<string>,
  maxFrameChars: number,
): Promise<void> {
  let authed = false;
  // Armed before the loop, and cleared by the handshake. An unauthenticated peer that simply
  // says nothing is indistinguishable from a slow one until this fires.
  const handshakeTimer = setTimeout(() => {
    if (!authed) socket.close(1008, 'mesh handshake timeout');
  }, HANDSHAKE_TIMEOUT_MS);
  handshakeTimer.unref?.();

  try {
    for await (const data of socket.inbound) {
      const raw = String(data);

      // Checked before `decode`, because decoding is the expensive part being defended. Until the
      // handshake, nothing larger than a hello is parsed, whatever the socket in front allowed.
      if (raw.length > (authed ? maxFrameChars : HELLO_FRAME_BYTES)) {
        socket.close(1009, 'mesh frame too large');
        break;
      }

      let frame: Frame;

      try {
        frame = decode(raw);
      } catch {
        continue; // undecodable frames are ignored, as before
      }

      if (!authed) {
        authed = handleHandshake(socket, frame, deps);
        if (authed) clearTimeout(handshakeTimer);
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
    clearTimeout(handshakeTimer);
    deps.bus?.emit('mesh:disconnect', { name: 'teapot' });
  }
}

/**
 * Build a control handler that authenticates peers and serves scope/route RPCs from the manifest.
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in a minor release.
 */
export function createMeshControl(deps: MeshControlDeps): {
  path: string;
  maxFrameBytes: number;
  handle: (socket: WsSocket) => Promise<void>;
} {
  const exportedScopes = new Set(deps.manifest.steps);
  const exportedRoutes = new Set(deps.manifest.routes.map((route) => `${route.method} ${route.pattern}`));
  const maxFrameChars = controlFrameLimit(deps.maxBodyBytes);

  return {
    path: MESH_CONTROL_PATH,
    /**
     * The inbound bound a server puts on this channel's WebSocket in place of
     * `limits.maxWsMessageBytes` (#120). The same figure as the character check below: the two agree
     * on ASCII, and on other text the byte bound is the one that binds — a body measured in bytes by
     * `maxBodyBytes` stays about that many bytes inside the envelope, so it still fits.
     */
    maxFrameBytes: maxFrameChars,
    /**
     * Resolves when the connection ends, mirroring `runWsConnection` — so `app.upgrade` can await
     * the control channel's lifetime the same way it awaits a regular ws route's.
     * `channel` is fan-out and subscribes when the async iterator is created, which `for await`
     * does synchronously, so the loop is live before any frame can arrive.
     */
    handle(socket: WsSocket): Promise<void> {
      return serveFrames(socket, deps, exportedScopes, exportedRoutes, maxFrameChars);
    },
  };
}

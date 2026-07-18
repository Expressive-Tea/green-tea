import type { Bus } from '../bus';
import { HttpError } from '../signals';
import { connectSocket, type SocketCtor } from '../http/ws-adapter';
import type { WsSocket } from '../http/ws-core';
import { encode, decode, MESH_PROTOCOL_VERSION, type Manifest, type RequestEnvelope, type Frame } from './protocol';

/** Client handle to a remote mesh server: its manifest, an RPC caller, and a close(). */
export interface Link {
  manifest: Manifest;
  rpc(kind: 'scope' | 'route', name: string, ctx: RequestEnvelope): Promise<unknown>;
  close(): void;
}

/** An in-flight RPC awaiting its `rpc-res`, keyed by id in the pending map. */
type PendingEntry = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Reject and clear every in-flight RPC — used when the link closes.
 * 503, not a bare Error: a dead upstream is not "this service broke", and the status is what
 * tells a caller it may retry and an operator where to look. A bare Error renders as a 500.
 */
function rejectAllPending(pending: Map<string, PendingEntry>, reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new HttpError(503, reason));
  }

  pending.clear();
}

/** Register one RPC in `pending` by id, send its request, and reject it on timeout. */
function sendRpc(
  socket: WsSocket,
  pending: Map<string, PendingEntry>,
  id: string,
  kind: 'scope' | 'route',
  name: string,
  ctx: RequestEnvelope,
  timeoutMs: number,
): Promise<unknown> {
  // Answer now rather than in timeoutMs. A closed socket cannot deliver the frame, so waiting
  // would make every request to a downed teapot hang for the full timeout (30s by default)
  // before failing anyway — the caller pays for a verdict already known.
  if (!socket.isOpen) {
    return Promise.reject(new HttpError(503, `mesh link is down: cannot resolve '${name}'`));
  }

  return new Promise((resolveCall, rejectCall) => {
    // 504: the link is alive but the teapot did not answer in time — a gateway timeout,
    // which is a different operational story from a link that is down.
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new HttpError(504, `mesh rpc timeout: ${name}`));
    }, timeoutMs);

    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
    socket.send(encode({ type: 'rpc-req', id, kind, name, ctx }));
  });
}

/** Assemble the client-facing Link once the manifest arrives. */
function buildLink(socket: WsSocket, pending: Map<string, PendingEntry>, manifest: Manifest, timeoutMs: number): Link {
  // ids only need to be unique within this link: `pending` is per-connection, so a
  // per-link counter suffices (no module-global sequence, no test-order coupling).
  let counter = 0;

  return {
    manifest,
    rpc(kind, name, ctx) {
      const id = String(counter++);

      return sendRpc(socket, pending, id, kind, name, ctx, timeoutMs);
    },
    close() {
      socket.close();
    },
  };
}

/** Settle a pending RPC from its `rpc-res` frame — resolve on ok, reject (and emit) on error. */
function settleRpcResponse(
  pending: Map<string, PendingEntry>,
  frame: Extract<Frame, { type: 'rpc-res' }>,
  bus?: Bus,
): void {
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  clearTimeout(entry.timer);

  if (frame.ok) {
    entry.resolve(frame.result);
  } else {
    bus?.emit('mesh:rpc:error', { name: frame.id, error: frame.error });
    entry.reject(new HttpError(frame.error.status ?? 500, frame.error.message));
  }
}

/** Default gap between heartbeat pings. Two missed rounds close the link. */
const HEARTBEAT_MS = 15_000;

/**
 * Close code for a link we hang up on because its teapot went quiet.
 *
 * Not 1011: a *client* may only send 1000 or 3000-4999 — anything else throws `invalid code`,
 * and our neutral close swallows throws, so a reserved code would leave the link open while
 * looking like it closed. 4000+ is the application range, so 4011 mirrors 1011's meaning.
 */
const CLOSE_HEARTBEAT_TIMEOUT = 4011;

/**
 * Pings the teapot on an interval and closes the link if a round goes unanswered.
 *
 * A TCP connection can die without either side noticing — a dropped route, a killed container,
 * a NAT timing out — leaving the socket "open" with nobody home. Without this, a teacup only
 * learns on the next request, which pays the full rpc timeout before failing. Closing the socket
 * turns that into an immediate 503 from the dead-link guard, and emits `mesh:disconnect`.
 *
 * The interval is unref'd, so a heartbeat never holds the process open by itself.
 */
function startHeartbeat(socket: WsSocket, everyMs: number): { stop: () => void; markAlive: () => void } {
  let answered = true;

  const timer = setInterval(() => {
    if (!answered) {
      socket.close(CLOSE_HEARTBEAT_TIMEOUT, 'mesh heartbeat timeout'); // aborts -> disconnect + reject pending
      return;
    }

    answered = false;
    socket.send(encode({ type: 'ping' }));
  }, everyMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    markAlive: () => {
      answered = true;
    },
  };
}

/** Handle for the in-flight handshake, so the frame loop can settle `connectLink`'s promise. */
interface Handshake {
  url: string;
  socket: WsSocket;
  pending: Map<string, PendingEntry>;
  timeoutMs: number;
  bus?: Bus;
  resolve: (link: Link) => void;
  reject: (error: unknown) => void;
  onManifest: () => void;
  onPong: () => void;
}

/** Settle the handshake from a `manifest` frame: refuse a version mismatch, else build the Link. */
function settleManifest(frame: Extract<Frame, { type: 'manifest' }>, hs: Handshake): void {
  if (frame.v !== MESH_PROTOCOL_VERSION) {
    hs.socket.close();
    hs.reject(
      new Error(
        `mesh protocol version mismatch at ${hs.url}: teapot speaks v${frame.v}, this teacup speaks v${MESH_PROTOCOL_VERSION}`,
      ),
    );

    return;
  }

  hs.onManifest();
  hs.bus?.emit('mesh:connect', { name: hs.url });
  hs.resolve(buildLink(hs.socket, hs.pending, { scopes: frame.scopes, routes: frame.routes }, hs.timeoutMs));
}

/** Consume the link's inbound frames until it closes, settling the handshake then each RPC. */
async function readFrames(hs: Handshake): Promise<void> {
  for await (const data of hs.socket.inbound) {
    let frame: Frame;

    try {
      frame = decode(String(data));
    } catch {
      continue; // undecodable frames are ignored
    }

    if (frame.type === 'manifest') settleManifest(frame, hs);
    else if (frame.type === 'pong') hs.onPong();
    else if (frame.type === 'rpc-res') settleRpcResponse(hs.pending, frame, hs.bus);
  }
}

/**
 * Open a WebSocket link to a mesh server, handshake with `secret`, and resolve once its manifest
 * arrives. `Ctor` is injectable to exercise both client implementations on a single runtime.
 */
export function connectLink(args: {
  url: string;
  secret: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  bus?: Bus;
  Ctor?: SocketCtor;
}): Promise<Link> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const { socket, opened } = connectSocket(args.url, args.Ctor ?? undefined);
  const pending = new Map<string, PendingEntry>();
  let manifest = false;
  let heartbeat: { stop: () => void; markAlive: () => void } | undefined;

  return new Promise<Link>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      socket.close();
      reject(new Error(`mesh connect timeout: ${args.url}`));
    }, timeoutMs);

    const hs: Handshake = {
      url: args.url,
      socket,
      pending,
      timeoutMs,
      bus: args.bus,
      resolve,
      reject,
      onManifest: () => {
        manifest = true;
        clearTimeout(connectTimer);
        // started only once authenticated: an unauthenticated peer should not be pinging
        heartbeat = startHeartbeat(socket, args.heartbeatMs ?? HEARTBEAT_MS);
      },
      onPong: () => heartbeat?.markAlive(),
    };

    opened.then(
      () => socket.send(encode({ type: 'hello', v: MESH_PROTOCOL_VERSION, secret: args.secret })),
      (error) => reject(error),
    );

    // abort fires on close *and* on error (see eventSocket), covering both paths the raw
    // 'close' listener used to: a refused handshake and a dropped link.
    socket.abort.addEventListener(
      'abort',
      () => {
        clearTimeout(connectTimer);
        heartbeat?.stop();
        args.bus?.emit('mesh:disconnect', { name: args.url });
        rejectAllPending(pending, `mesh link to ${args.url} is down`);
        if (!manifest) reject(new Error(`mesh handshake failed: ${args.url}`));
      },
      { once: true },
    );

    void readFrames(hs).catch(() => {
      /* inbound failed; the abort listener above reports it */
    });
  });
}

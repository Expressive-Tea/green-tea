import type { Bus } from '../bus';
import type { Logger } from '../logger';
import { HttpError } from '../signals';
import { connectSocket, type SocketCtor } from '../http/ws-adapter';
import { compilePattern } from '../http/router';
import type { WsSocket } from '../http/ws-core';
import { encode, decode, MESH_PROTOCOL_VERSION, type Manifest, type RequestEnvelope, type Frame } from './protocol';

/** Client handle to a remote mesh server: its manifest, an RPC caller, and a close(). */
export interface Link {
  manifest: Manifest;
  rpc(kind: 'scope' | 'route', name: string, ctx: RequestEnvelope): Promise<unknown>;
  close(): void;
}

/** Backoff bounds for reconnection. `false` disables reconnecting entirely. */
export interface ReconnectOptions {
  /** Delay before the first retry; doubles from here (default: 500ms). */
  initialDelayMs?: number;
  /** Ceiling the doubling stops at (default: 30s). */
  maxDelayMs?: number;
}

/**
 * What to do when a reconnecting teapot answers with a manifest that no longer backs the graph.
 *
 * Only `'refuse'` exists. It is a named strategy rather than implicit behaviour so that hot graph
 * reconciliation can arrive later as `'reconcile'` *additively* — peers run on separate deploy
 * cadences, and silently changing what the default means is the worst kind of breaking change.
 */
export type ManifestPolicy = 'refuse';

/**
 * A connection failure the peer decided, rather than one the network caused.
 *
 * The distinction is what boot retry needs: a refused secret or a version mismatch will fail
 * identically forever, so retrying one spends a deploy's patience to reach the same error. It is
 * derived from whether the socket ever *opened* — a peer that accepted the connection and then hung
 * up before the manifest rejected us on purpose; one that never accepted it may simply not be up.
 */
export function isPermanentRefusal(error: unknown): boolean {
  return (error as { meshRefused?: boolean } | undefined)?.meshRefused === true;
}

/** Tag an error as a decision by the peer, so the caller does not retry it. */
function refused(message: string): Error {
  const error = new Error(message) as Error & { meshRefused: boolean };
  error.meshRefused = true;

  return error;
}

/** An in-flight RPC awaiting its `rpc-res`, keyed by id in the pending map. */
type PendingEntry = {
  /** The token or route asked for. Kept so an error can be reported by name — the frame only carries the id. */
  name: string;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Mutable per-link state: which socket is current, and whether the application hung up for good. */
interface LinkState {
  socket: WsSocket | undefined;
  closed: boolean;
  retry: ReturnType<typeof setTimeout> | undefined;
}

/** One established connection: its socket, the manifest it announced, and its heartbeat. */
interface Session {
  socket: WsSocket;
  manifest: Manifest;
  heartbeat: { stop: () => void; markAlive: () => void };
}

const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Reject and clear every in-flight RPC — used when a session ends.
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
  socket: WsSocket | undefined,
  pending: Map<string, PendingEntry>,
  id: string,
  kind: 'scope' | 'route',
  name: string,
  ctx: RequestEnvelope,
  timeoutMs: number,
): Promise<unknown> {
  // Answer now rather than in timeoutMs. A closed socket cannot deliver the frame, so waiting
  // would make every request to a downed teapot hang for the full timeout (30s by default)
  // before failing anyway — the caller pays for a verdict already known. This is also the
  // window a reconnecting link sits in: down, and answering immediately.
  if (!socket?.isOpen) {
    return Promise.reject(new HttpError(503, `mesh link is down: cannot resolve '${name}'`));
  }

  return new Promise((resolveCall, rejectCall) => {
    // 504: the link is alive but the teapot did not answer in time — a gateway timeout,
    // which is a different operational story from a link that is down.
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new HttpError(504, `mesh rpc timeout: ${name}`));
    }, timeoutMs);

    pending.set(id, { name, resolve: resolveCall, reject: rejectCall, timer });
    socket.send(encode({ type: 'rpc-req', id, kind, name, ctx }));
  });
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
    // `entry.name`, not `frame.id`: the id is a per-link counter, so this event used to report
    // "0" or "1" where every other emitter reports what failed — including the teapot's own
    // emit for the same call, which made the two sides of one failure impossible to line up.
    bus?.emit('mesh:rpc:error', { name: entry.name, error: frame.error });
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
 * turns that into an immediate 503 from the dead-link guard, emits `mesh:disconnect`, and starts
 * the reconnect backoff.
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

/** Handle for the in-flight handshake, so the frame loop can settle the session promise. */
interface Handshake {
  url: string;
  socket: WsSocket;
  pending: Map<string, PendingEntry>;
  bus?: Bus;
  resolve: (session: Session) => void;
  reject: (error: unknown) => void;
  onManifest: (socket: WsSocket) => Session['heartbeat'];
  onPong: () => void;
}

/** Settle the handshake from a `manifest` frame: refuse a version mismatch, else hand back the session. */
function settleManifest(frame: Extract<Frame, { type: 'manifest' }>, hs: Handshake): void {
  if (frame.v !== MESH_PROTOCOL_VERSION) {
    hs.socket.close();
    hs.reject(
      refused(
        `mesh protocol version mismatch at ${hs.url}: teapot speaks v${frame.v}, this teacup speaks v${MESH_PROTOCOL_VERSION}`,
      ),
    );

    return;
  }

  const heartbeat = hs.onManifest(hs.socket);

  // `mesh:connect` is emitted by the caller, not here: a reconnect whose manifest no longer backs
  // the graph is refused after this point, and announcing a connection we are about to hang up on
  // would tell an operator the opposite of what happened.
  hs.resolve({ socket: hs.socket, manifest: { scopes: frame.scopes, routes: frame.routes }, heartbeat });
}

/** Consume the session's inbound frames until it closes, settling the handshake then each RPC. */
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

/** Everything a link needs to open one session, shared by the first connect and every retry. */
interface SessionArgs {
  url: string;
  secret: string;
  timeoutMs: number;
  heartbeatMs: number;
  pending: Map<string, PendingEntry>;
  bus?: Bus;
  Ctor?: SocketCtor;
  onEnd: () => void;
}

/**
 * Open one authenticated session: connect, handshake, and resolve once the manifest arrives.
 *
 * `onEnd` fires when this session's socket aborts — on a clean close and on an error alike — and is
 * where the supervisor rejects in-flight RPCs and decides whether to retry. It fires for a session
 * that never handshook too, which is what turns a refused connection into a scheduled retry rather
 * than a silent stall.
 */
function openSession(args: SessionArgs): Promise<Session> {
  const { socket, opened } = connectSocket(args.url, args.Ctor ?? undefined);
  let heartbeat: Session['heartbeat'] | undefined;
  let handshook = false;
  let accepted = false;

  return new Promise<Session>((resolve, reject) => {
    const connectTimer = setTimeout(() => {
      socket.close();
      reject(new Error(`mesh connect timeout: ${args.url}`));
    }, args.timeoutMs);

    const hs: Handshake = {
      url: args.url,
      socket,
      pending: args.pending,
      bus: args.bus,
      resolve,
      reject,
      onManifest: (established) => {
        handshook = true;
        clearTimeout(connectTimer);
        // started only once authenticated: an unauthenticated peer should not be pinging
        heartbeat = startHeartbeat(established, args.heartbeatMs);

        return heartbeat;
      },
      onPong: () => heartbeat?.markAlive(),
    };

    opened.then(
      () => {
        accepted = true;
        socket.send(encode({ type: 'hello', v: MESH_PROTOCOL_VERSION, secret: args.secret }));
      },
      (error) => reject(error),
    );

    // abort fires on close *and* on error (see eventSocket), covering both paths the raw
    // 'close' listener used to: a refused handshake and a dropped link.
    socket.abort.addEventListener(
      'abort',
      () => {
        clearTimeout(connectTimer);
        heartbeat?.stop();

        if (!handshook) {
          // Opened and then hung up before answering: the teapot refused this peer — a bad secret,
          // or a version it would not speak. Never opened: it may just not be listening yet.
          const message = `mesh handshake failed: ${args.url}`;

          reject(accepted ? refused(message) : new Error(message));
        }

        args.onEnd();
      },
      { once: true },
    );

    void readFrames(hs).catch(() => {
      /* inbound failed; the abort listener above reports it */
    });
  });
}

/** A scope token and its lifetime, flattened to the string the refusal check compares. */
function scopeKeys(manifest: Manifest): Set<string> {
  return new Set(manifest.scopes.map((scope) => `${scope.scope}:${scope.token}`));
}

/**
 * Route keys by method plus *effective shape*, the same comparison `spliceRemoteScopes` uses to
 * detect ambiguity — so `/:id` renamed to `/:name` is the same route and does not trip the refusal.
 */
function routeKeys(manifest: Manifest): Set<string> {
  return new Set(manifest.routes.map((route) => `${route.method} ${compilePattern(route.pattern).shape}`));
}

/**
 * What the boot manifest had that a returning one does not.
 *
 * The graph was validated at boot against the first manifest and is already serving. A token that
 * vanished cannot be validated away after the fact, so a manifest missing anything this link
 * contributed is refused rather than accepted — see `ManifestPolicy`. Extra exports are *not*
 * missing and are ignored: the graph is fixed at boot and nothing new is spliced into it.
 */
export function missingFromManifest(booted: Manifest, returned: Manifest): string[] {
  const scopes = scopeKeys(returned);
  const routes = routeKeys(returned);
  const missing: string[] = [];

  for (const scope of booted.scopes) {
    if (!scopes.has(`${scope.scope}:${scope.token}`)) missing.push(`${scope.scope}-scope '${scope.token}'`);
  }

  for (const route of booted.routes) {
    if (!routes.has(`${route.method} ${compilePattern(route.pattern).shape}`)) {
      missing.push(`route '${route.method} ${route.pattern}'`);
    }
  }

  return missing;
}

/** Resolved backoff bounds, or `undefined` when the caller turned reconnection off. */
function backoffBounds(
  reconnect: boolean | ReconnectOptions | undefined,
): { initial: number; max: number } | undefined {
  if (reconnect === false) return undefined;
  const opts = typeof reconnect === 'object' ? reconnect : {};

  return {
    initial: opts.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    max: opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };
}

/**
 * Open a WebSocket link to a mesh server, handshake with `secret`, and resolve once its manifest
 * arrives. The returned `Link` outlives any single socket: when a session drops, the link keeps its
 * identity — the graph captured `rpc` at boot — and reconnects underneath it.
 *
 * `Ctor` is injectable to exercise both client implementations on a single runtime.
 */
export function connectLink(args: {
  url: string;
  secret: string;
  timeoutMs?: number;
  heartbeatMs?: number;
  bus?: Bus;
  Ctor?: SocketCtor;
  /** Reconnect after a dropped session (default: on). `false` restores the old fail-once behaviour. */
  reconnect?: boolean | ReconnectOptions;
  /** What to do when a returning teapot's manifest no longer backs the graph (default: `'refuse'`). */
  onManifestChange?: ManifestPolicy;
  /** Called after a *successful* reconnect, so app-scope values resolved from this link are re-resolved. */
  onReconnect?: () => void;
  logger?: Logger;
}): Promise<Link> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const heartbeatMs = args.heartbeatMs ?? HEARTBEAT_MS;
  const bounds = backoffBounds(args.reconnect);
  const pending = new Map<string, PendingEntry>();
  const state: LinkState = { socket: undefined, closed: false, retry: undefined };
  let refusalLogged = '';

  const link: Link = {
    // replaced with the real manifest before this object escapes; a reconnect never changes it,
    // because the graph is fixed at boot and only the *boot* manifest describes what it holds.
    manifest: { scopes: [], routes: [] },
    rpc: (kind, name, ctx) => sendRpc(state.socket, pending, String(counter++), kind, name, ctx, timeoutMs),
    close: () => {
      // Terminal, by contract. `closeLinks` runs on shutdown, and a link that reconnected after
      // the application hung up would leave a process that cannot exit.
      state.closed = true;
      clearTimeout(state.retry);
      state.socket?.close();
    },
  };
  // ids only need to be unique within this link: `pending` is per-link, so a per-link counter
  // suffices (no module-global sequence, no test-order coupling).
  let counter = 0;

  const sessionArgs = (onEnd: () => void): SessionArgs => ({
    url: args.url,
    secret: args.secret,
    timeoutMs,
    heartbeatMs,
    pending,
    bus: args.bus,
    Ctor: args.Ctor,
    onEnd,
  });

  /** Schedule the next attempt, doubling from `initial` up to `max` with jitter. */
  const scheduleRetry = (attempt: number): void => {
    if (state.closed || !bounds) return;
    const capped = Math.min(bounds.initial * 2 ** attempt, bounds.max);
    // Full jitter: peers that went down together must not come back in lockstep and stampede
    // the teapot the moment it returns.
    const delay = Math.round(capped / 2 + Math.random() * (capped / 2));

    state.retry = setTimeout(() => void attemptReconnect(attempt + 1), delay);
    state.retry.unref?.();
  };

  /** End the current session: nothing can be delivered on it, so fail what was waiting. */
  const endSession = (attempt: number): void => {
    state.socket = undefined;
    args.bus?.emit('mesh:disconnect', { name: args.url });
    rejectAllPending(pending, `mesh link to ${args.url} is down`);
    scheduleRetry(attempt);
  };

  /** Adopt an established session, or refuse it when its manifest no longer backs the graph. */
  const adopt = (session: Session, attempt: number, reconnected: boolean): boolean => {
    const missing = missingFromManifest(link.manifest, session.manifest);

    if (missing.length > 0) {
      session.heartbeat.stop();
      session.socket.close();
      // Logged once per distinct manifest, not once per attempt: at the 30s ceiling this would
      // otherwise be ~2,880 identical lines a day. A rollback can still fix it, which is why the
      // link keeps retrying rather than giving up.
      const fingerprint = missing.join('|');

      if (fingerprint !== refusalLogged) {
        refusalLogged = fingerprint;
        args.logger?.warn(
          `mesh: refusing to reconnect to ${args.url} — its manifest no longer exports ${missing.join(', ')}, ` +
            'which the graph was validated against at boot. Retrying in case this is a partial deploy.',
        );
      }

      return false;
    }

    refusalLogged = '';
    state.socket = session.socket;
    args.bus?.emit('mesh:connect', { name: args.url });
    if (reconnected) args.onReconnect?.();

    return true;
  };

  const attemptReconnect = async (attempt: number): Promise<void> => {
    if (state.closed) return;

    try {
      const session = await openSession(sessionArgs(() => endSession(attempt)));

      if (state.closed) {
        session.socket.close(); // hung up while this attempt was in flight
        return;
      }

      if (!adopt(session, attempt, true)) scheduleRetry(attempt);
    } catch {
      // openSession's own abort listener already scheduled the retry through `onEnd`; a rejection
      // that never opened a socket (a bad URL, DNS) needs one scheduled here instead.
      if (!state.socket && !state.retry) scheduleRetry(attempt);
    }
  };

  return openSession(sessionArgs(() => endSession(0))).then((session) => {
    link.manifest = session.manifest;
    adopt(session, 0, false);

    return link;
  });
}

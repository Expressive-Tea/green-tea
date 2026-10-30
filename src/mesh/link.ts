import type { Bus } from '../bus';
import type { Logger } from '../logger';
import { HttpError } from '../signals';
import { connectSocket, type SocketCtor } from '../http/ws-adapter';
import { sendWhenDrained, type WsSocket } from '../http/ws-core';
import { encode, decode, MESH_PROTOCOL_VERSION, type Manifest, type RequestEnvelope, type Frame } from './protocol';

/**
 * Client handle to a remote mesh server: its manifest, an RPC caller, and a close().
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in any release.
 */
export interface Link {
  manifest: Manifest;
  rpc(kind: 'scope' | 'route', name: string, ctx: RequestEnvelope): Promise<unknown>;
  close(): void;
}

/**
 * Backoff bounds for reconnection. `false` disables reconnecting entirely.
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in any release.
 */
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
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in any release.
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
  /** When the scheduled reconnect attempt fires (epoch ms), for the `retry-after` a 503 carries. */
  retryAt: number | undefined;
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
function rejectAllPending(pending: Map<string, PendingEntry>, reason: string, headers?: Record<string, string>): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new HttpError(503, reason, undefined, headers));
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
  downHeaders?: Record<string, string>,
): Promise<unknown> {
  // Answer now rather than in timeoutMs. A closed socket cannot deliver the frame, so waiting
  // would make every request to a downed teapot hang for the full timeout (30s by default)
  // before failing anyway — the caller pays for a verdict already known. This is also the
  // window a reconnecting link sits in: down, and answering immediately.
  if (!socket?.isOpen) {
    return Promise.reject(new HttpError(503, `mesh link is down: cannot resolve '${name}'`, undefined, downHeaders));
  }

  return new Promise((resolveCall, rejectCall) => {
    // 504: the link is alive but the teapot did not answer in time — a gateway timeout,
    // which is a different operational story from a link that is down.
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCall(new HttpError(504, `mesh rpc timeout: ${name}`));
    }, timeoutMs);

    pending.set(id, { name, resolve: resolveCall, reject: rejectCall, timer });
    // Not before the socket has room (#41); the timeout already runs, so a teapot that stops
    // reading still answers 504. Settled while waiting (timeout, close): nothing left to send.
    void sendWhenDrained(socket, () =>
      pending.has(id) ? encode({ type: 'rpc-req', id, kind, name, ctx }) : undefined,
    );
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
  hs.resolve({ socket: hs.socket, manifest: { steps: frame.steps, routes: frame.routes }, heartbeat });
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

/** A manifest's step tokens, flattened to the set the refusal check compares. */
function stepKeys(manifest: Manifest): Set<string> {
  return new Set(manifest.steps);
}

/**
 * The steps the boot manifest had that a returning one does not.
 *
 * The graph was validated at boot against the first manifest and is already serving. A step token
 * that vanished cannot be validated away after the fact, so a manifest missing one is refused
 * rather than accepted — see `ManifestPolicy`. Extra steps are ignored: the graph is fixed at boot
 * and nothing new is spliced into it.
 *
 * Routes are not compared. They are not part of the graph, so a returning teapot's routes replace
 * the old ones instead (D15): a route it added is served, one it dropped is removed.
 */
export function missingFromManifest(booted: Manifest, returned: Manifest): string[] {
  const steps = stepKeys(returned);
  const missing: string[] = [];

  for (const step of booted.steps) {
    if (!steps.has(step)) missing.push(`step '${step}'`);
  }

  return missing;
}

/**
 * `retry-after` for a 503 while the link is down and will try again: the seconds until the next
 * attempt, at least 1. Nothing when it will not try again, so a client is not told to come back to
 * a link that has given up.
 */
function retryAfter(state: LinkState, reconnects: boolean): Record<string, string> | undefined {
  if (state.closed || !reconnects) return undefined;
  const waitMs = state.retryAt === undefined ? 0 : state.retryAt - Date.now();

  return { 'retry-after': String(Math.max(1, Math.ceil(waitMs / 1000))) };
}

/** A session dropped with reconnection off: the link is gone for good, if it was ever up. */
function dropWithoutReconnect(adopted: boolean, giveUp: () => void): void {
  if (adopted) giveUp();
}

/** Stop a link for good and say so: a drop with reconnection off, or a permanent refusal (D15). */
function stopForGood(state: LinkState, onGone: (() => void) | undefined): void {
  if (state.closed) return;
  state.closed = true;
  clearTimeout(state.retry);
  state.retry = undefined;
  onGone?.();
}

/**
 * Whether a failed reconnect attempt was the teapot refusing this peer on purpose, in which case the
 * link gives up. Retrying reaches the same answer forever, so the link stops and its routes go (D15),
 * the same verdict boot gives a refusal.
 */
function refusedWhileReconnecting(
  url: string,
  error: unknown,
  logger: Logger | undefined,
  giveUp: () => void,
): boolean {
  if (!isPermanentRefusal(error)) return false;
  logger?.warn(`mesh: ${url} refused this peer while reconnecting (${(error as Error).message}) — giving up on it.`);
  giveUp();

  return true;
}

/**
 * Hang up on a session whose manifest no longer backs the graph, and return the fingerprint now logged.
 *
 * Logged once per distinct manifest, not once per attempt: at the 30s ceiling this would otherwise be
 * ~2,880 identical lines a day. A rollback can still fix it, which is why the link keeps retrying
 * rather than giving up.
 */
function refuseSession(
  session: Session,
  missing: string[],
  logged: string,
  url: string,
  logger: Logger | undefined,
): string {
  session.heartbeat.stop();
  session.socket.close();
  const fingerprint = missing.join('|');

  if (fingerprint !== logged) {
    logger?.warn(
      `mesh: refusing to reconnect to ${url} — its manifest no longer exports ${missing.join(', ')}, ` +
        'which the graph was validated against at boot. Retrying in case this is a partial deploy.',
    );
  }

  return fingerprint;
}

/** A session was adopted. When it is a returning one: keep the boot steps, take its routes (D15), and tell the caller. */
function reconnected(
  returning: boolean,
  link: Link,
  returned: Manifest,
  onReconnect: ((manifest: Manifest) => void) | undefined,
): void {
  if (!returning) return;
  link.manifest = { steps: link.manifest.steps, routes: returned.routes };
  onReconnect?.(link.manifest);
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
 *
 * @experimental Part of the mesh, which needs `createApp({ experimental: true })`: outside the
 * API freeze, so it may change in any release.
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
  logger?: Logger;
  /**
   * Called each time a dropped link reconnects and its session is adopted, after `link.manifest`
   * has taken the returning manifest's routes. Not called for the first connection: the caller
   * has the link, and its manifest, when the returned promise resolves.
   */
  onReconnect?: (manifest: Manifest) => void;
  /**
   * Called once when the link gives up for good: its session dropped with `reconnect: false`, or a
   * reconnect attempt was refused permanently (a wrong secret, a protocol mismatch). Not called by
   * `close()`, which is the application hanging up, not the teapot going away.
   */
  onGone?: () => void;
}): Promise<Link> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const heartbeatMs = args.heartbeatMs ?? HEARTBEAT_MS;
  const bounds = backoffBounds(args.reconnect);
  const pending = new Map<string, PendingEntry>();
  const state: LinkState = { socket: undefined, closed: false, retry: undefined, retryAt: undefined };
  let refusalLogged = '';
  let adopted = false; // a session was adopted at least once, so the link has something to lose

  const downHeaders = (): Record<string, string> | undefined => retryAfter(state, bounds !== undefined);
  const giveUp = (): void => stopForGood(state, args.onGone);

  const link: Link = {
    // replaced with the real manifest before this object escapes. A reconnect keeps the boot
    // manifest's steps, because the graph is fixed at boot, and takes the returning one's routes.
    manifest: { steps: [], routes: [] },
    rpc: (kind, name, ctx) =>
      sendRpc(state.socket, pending, String(counter++), kind, name, ctx, timeoutMs, downHeaders()),
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

    clearTimeout(state.retry);
    state.retryAt = Date.now() + delay;
    state.retry = setTimeout(() => void attemptReconnect(attempt + 1), delay);
    state.retry.unref?.();
  };

  /** End the current session: nothing can be delivered on it, so fail what was waiting. */
  const endSession = (attempt: number): void => {
    state.socket = undefined;
    args.bus?.emit('mesh:disconnect', { name: args.url });
    // Scheduled before the rejection, so the 503s carry the real wait in `retry-after`.
    scheduleRetry(attempt);
    rejectAllPending(pending, `mesh link to ${args.url} is down`, downHeaders());
    // With reconnection off, a link that was up and dropped is gone for good (D15). `adopted`
    // keeps a first connect that never succeeded out of this: that link never escaped.
    if (!bounds) dropWithoutReconnect(adopted, giveUp);
  };

  /** Adopt an established session, or refuse it when its manifest no longer backs the graph. */
  const adopt = (session: Session): boolean => {
    const missing = missingFromManifest(link.manifest, session.manifest);

    if (missing.length > 0) {
      refusalLogged = refuseSession(session, missing, refusalLogged, args.url, args.logger);
      return false;
    }

    refusalLogged = '';
    state.socket = session.socket;
    const returning = adopted;
    adopted = true;
    args.bus?.emit('mesh:connect', { name: args.url });
    reconnected(returning, link, session.manifest, args.onReconnect);

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

      if (!adopt(session)) scheduleRetry(attempt);
    } catch (error) {
      // A permanent refusal ends the link. Otherwise: openSession's own abort listener already
      // scheduled the retry through `onEnd`; a rejection that never opened a socket (a bad URL,
      // DNS) needs one scheduled here instead.
      if (!refusedWhileReconnecting(args.url, error, args.logger, giveUp) && !state.socket && !state.retry)
        scheduleRetry(attempt);
    }
  };

  return openSession(sessionArgs(() => endSession(0))).then(
    (session) => {
      link.manifest = session.manifest;
      adopt(session);

      return link;
    },
    (error) => {
      // The first connect failed, so this `Link` never escaped — nobody holds it and nobody can
      // ever call `close()` on it. But `openSession`'s abort listener has already run `onEnd`,
      // which scheduled a retry: left alone, that supervisor reconnects forever to a handle no
      // caller has, and `closeLinks` cannot reach it because the link was never pushed to
      // `meshLinks`. Boot already retries above this (`connectUntilDeadline`), so a second
      // supervisor underneath it is pure leak — every failed attempt used to leave one behind.
      // Reconnection for a link that *did* connect is untouched: this path runs only on the
      // initial rejection, and a session that drops later still goes through `endSession`.
      state.closed = true;
      clearTimeout(state.retry);
      throw error;
    },
  );
}

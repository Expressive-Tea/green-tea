import { channel } from '../channel';
import type { App } from '../app/types';
import type { WsRequest, WsSocket } from './ws-core';

/**
 * Shared plumbing for the runtime adapters (Bun/Deno/edge) that bridge a host WebSocket
 * to the neutral {@link WsSocket} the core talks to. Separate from `ws-core` on purpose:
 * that module *runs* a connection, this one *builds* one from a host runtime's socket.
 */

const decoder = new TextDecoder();
const OPEN = 1; // WebSocket.OPEN — same constant in every runtime; avoids a per-runtime ambient

/** Decodes a host `message` payload to the string the core expects (parity with Node's Buffer.toString()). */
export function decodeMessage(data: string | ArrayBuffer | Uint8Array): string {
  return typeof data === 'string' ? data : decoder.decode(data);
}

/**
 * Builds a neutral {@link WsRequest} from a Web-standard `Request`. Every adapter derives
 * url/headers/protocol identically; only the client IP is runtime-specific, so it's passed in.
 */
export function toWsRequest(request: Request, ip: string): WsRequest {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    url: url.pathname + url.search,
    headers,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    ip,
  };
}

/** The subset of a host WebSocket that {@link eventSocket} drives (Deno's WebSocket and workerd's both satisfy it). */
export interface EventfulSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: string | ArrayBuffer; error?: unknown }) => void,
  ): void;
}

/**
 * Wraps an `addEventListener`-style host socket (Deno, workerd) as a neutral {@link WsSocket}:
 * creates the inbound channel and abort controller and wires message/close/error into them.
 * Bun does not use this — its socket events are delivered to a server-level handler rather
 * than the socket, so it builds its own {@link WsSocket} over state stashed on `ws.data`.
 */
export function eventSocket(host: EventfulSocket): WsSocket {
  const inbound = channel<unknown>();
  const ac = new AbortController();

  host.addEventListener('message', (event) => {
    inbound.push(decodeMessage(event.data as string | ArrayBuffer));
  });
  host.addEventListener('close', () => {
    inbound.close();
    ac.abort();
  });
  host.addEventListener('error', () => {
    inbound.fail(new Error('websocket error'));
    ac.abort();
  });

  return neutralSocket(host, inbound, ac);
}

/**
 * Wraps a host socket's send/close/readyState as a neutral {@link WsSocket} over an
 * already-wired channel and abort controller. `close`/`terminate` swallow throws so
 * callers never have to guard an already-closed socket.
 */
export function neutralSocket(
  host: Pick<EventfulSocket, 'readyState' | 'send' | 'close'> & { terminate?(): void },
  inbound: ReturnType<typeof channel<unknown>>,
  ac: AbortController,
): WsSocket {
  return {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return host.readyState === OPEN;
    },
    send: (data) => {
      host.send(data);
    },
    close: (code, reason) => {
      try {
        host.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    terminate: () => {
      try {
        (host.terminate ?? host.close).call(host);
      } catch {
        /* already closed */
      }
    },
  };
}

/** Constructs a host WebSocket *client*. Both the platform global and the `ws` package satisfy it. */
export type SocketCtor = new (url: string) => EventfulSocket;

/**
 * The WebSocket client implementation: the platform global where it exists (Deno, Bun, and
 * Node >= 22), else the `ws` optional peer — Node 18-21, our declared floor, has no global.
 *
 * Both expose the same `addEventListener` API and deliver text frames as `event.data` strings,
 * so one bridge covers both. That is verified rather than assumed: `ws` implements the
 * browser-compatible event API alongside its EventEmitter one.
 */
export function loadWebSocketCtor(): SocketCtor {
  const platform = (globalThis as { WebSocket?: SocketCtor }).WebSocket;

  if (platform) return platform;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ws') as SocketCtor;
}

/**
 * Opens a client connection and wraps it as a neutral {@link WsSocket}. `opened` resolves once
 * the socket is live (the caller's cue to send its first frame) and rejects if it never opens.
 *
 * `Ctor` is injectable so both implementations can be exercised on one runtime — otherwise CI
 * on a single Node version would silently cover only one of the two paths.
 */
export function connectSocket(
  url: string,
  Ctor: SocketCtor = loadWebSocketCtor(),
): { socket: WsSocket; opened: Promise<void> } {
  const host = new Ctor(url);
  // registered before eventSocket's own error listener, so a connect failure rejects `opened`
  // with the host's real error rather than eventSocket's generic one
  const opened = new Promise<void>((resolve, reject) => {
    host.addEventListener('open', () => resolve());
    host.addEventListener('error', (event) => reject(event?.error ?? new Error(`websocket error: ${url}`)));
  });

  return { socket: eventSocket(host), opened };
}

/**
 * Runs the ws lifecycle, closing with 1011 if it rejects. `app.upgrade` can reject *before*
 * `runWsConnection`'s own try/catch (mesh-before-listen, provider boot failure); unguarded,
 * that surfaces as an uncaught rejection and is fatal on Bun/Deno. Returns the promise so
 * edge can hand it to `ctx.waitUntil`.
 */
export function upgradeSafely(app: App, request: WsRequest, socket: WsSocket): Promise<void> {
  return app.upgrade(request, socket).catch(() => {
    socket.close(1011, 'internal error'); // neutral close already swallows throws
  });
}

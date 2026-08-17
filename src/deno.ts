import type { App } from './app/types';
import { eventSocket, toWsRequest, upgradeSafely, type EventfulSocket } from './http/ws-adapter';
import { closeWithDeadline } from './http/shutdown';

// The project tsconfig's `lib` doesn't include `DOM`, and the installed `@types/node` (18.x)
// doesn't declare a global `WebSocket` either — so we ambient-declare just the shape we use.
interface WebSocket extends EventfulSocket {
  binaryType: string;
}

// Minimal ambient for the Deno globals we use — avoids a @types/deno devDep.
// Mirrors the real Deno.serve / Deno.upgradeWebSocket signatures we call.
interface DenoServeOptions {
  port?: number;
  hostname?: string;
  signal?: AbortSignal;
  onListen?: (addr: { hostname: string; port: number }) => void;
}
interface DenoServeHandlerInfo {
  remoteAddr: { hostname: string; port: number; transport: string };
}
interface DenoHttpServer {
  finished: Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * What {@link serveDeno} hands back: Deno's own server, plus the bounded `close()` that
 * `app.close()` cannot provide here. `app.close()` returns at its `if (!server)` guard on Deno,
 * because a Deno app is served through `app.fetch` and never through `listen()`.
 */
export interface DenoServer extends DenoHttpServer {
  /**
   * Drains in-flight requests, returning after at most `timeoutMs` (default: 10s).
   *
   * **The deadline bounds the wait, not the connections** — unlike Node's `app.close()` and Bun's
   * `close()`, which force the remainder shut. Deno offers no force-close that composes with a
   * drain already under way: aborting the serve signal at that point throws `BadResource` from
   * Deno's own listener, uncaught. Whatever is still open when this resolves ends with the process.
   */
  close(options?: { timeoutMs?: number }): Promise<void>;
}
type DenoServeHandler = (request: Request, info: DenoServeHandlerInfo) => Response | Promise<Response>;
declare const Deno: {
  serve(options: DenoServeOptions, handler: DenoServeHandler): DenoHttpServer;
  upgradeWebSocket(request: Request): { socket: WebSocket; response: Response };
};

/**
 * Serve a Green Tea app on Deno: HTTP + SSE via app.fetch, WebSocket via Deno.upgradeWebSocket.
 * WebSocket messages flow through app.upgrade over the shared neutral core.
 * Deno.serve exposes no equivalent to Node's server.maxConnections; enforce connection caps at
 * the deployment platform or reverse proxy.
 */
export function serveDeno(app: App, options?: DenoServeOptions): DenoServer {
  // Deno's only force-close lever is the abort signal it was served with, so the adapter has to
  // own one to offer a deadline at all. A caller-supplied signal still works and still aborts the
  // server — it is chained into ours rather than replaced, so neither party loses its control.
  const ac = new AbortController();
  options?.signal?.addEventListener('abort', () => ac.abort(), { once: true });

  const server = Deno.serve({ ...options, signal: ac.signal }, (request, info) => {
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      // Deno invalidates request connection metadata as soon as the upgrade is accepted.
      const wsRequest = toWsRequest(request, info.remoteAddr.hostname);
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.binaryType = 'arraybuffer'; // deliver binary frames as ArrayBuffer, which decodeMessage expects
      // fire-and-forget: the 101 response must be returned synchronously while the graph runs
      void upgradeSafely(app, wsRequest, eventSocket(socket));
      return response;
    }

    return app.fetch(request);
  });

  // Object.assign rather than a fresh object: Deno.serve returns more than the ambient above
  // declares (addr, ref, unref, …), and rebuilding would silently drop whatever we did not name.
  return Object.assign(server, {
    close: (closeOptions: { timeoutMs?: number } = {}): Promise<void> =>
      closeWithDeadline(
        // Drain, then hand over to the app so registered teardown runs — D7 of the teardown design.
        // `app.close()` returns at its no-server guard on Deno, but still drains the teardown
        // registry, which is what makes one `close()` enough here instead of two. Called without
        // options on purpose: passing a timeout it cannot use to drain would only earn its warning,
        // and the deadline below already bounds the whole call.
        () => server.shutdown().then(() => app.close()),
        // Nothing to force, and that is Deno's constraint rather than an omission here. Its two
        // levers are mutually exclusive: aborting the serve signal after `shutdown()` is already
        // pending throws `BadResource: Bad resource ID` from Deno's own abort listener, which
        // surfaces uncaught — not catchable at this call site, and fatal under `deno test`.
        // Measured on Deno 2.9: abort alone is clean, abort after shutdown is not. So Deno cannot
        // escalate from graceful to forced the way Node's closeAllConnections() and Bun's
        // stop(true) can, and the deadline here bounds how long `close()` waits, not when the
        // connections die. Exiting the process after `close()` resolves is what ends them.
        () => {},
        closeOptions.timeoutMs ?? 10_000,
        (ms) =>
          app.logger.warn(
            `graceful shutdown timed out after ${ms}ms — returning anyway. Deno cannot force-close ` +
              'a server that is already draining, so remaining connections end when the process does.',
            { timeoutMs: ms, runtime: 'deno' },
          ),
      ),
  });
}

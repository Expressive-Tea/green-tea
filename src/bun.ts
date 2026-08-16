import { channel } from './channel';
import type { Channel } from './channel';
import type { App } from './app/types';
import type { WsSocket, WsRequest } from './http/ws-core';
import { decodeMessage, neutralSocket, toWsRequest, upgradeSafely } from './http/ws-adapter';
import { closeWithDeadline } from './http/shutdown';

// Minimal ambient for the Bun globals we use — avoids a @types/bun devDep.
// Mirrors the real Bun.serve / server.upgrade / ServerWebSocket signatures we call.
interface BunServerWebSocket {
  data: unknown;
  readyState: number;
  send(data: string): number;
  close(code?: number, reason?: string): void;
  terminate?(): void;
}
interface BunWebSocketHandler {
  open?(ws: BunServerWebSocket): void;
  message(ws: BunServerWebSocket, message: string | Uint8Array): void;
  close?(ws: BunServerWebSocket, code: number, reason: string): void;
  error?(ws: BunServerWebSocket, error?: unknown): void;
}
interface BunServer {
  port: number;
  // Returns a promise, verified on Bun 1.3 — the previous `void` here was simply wrong, and it
  // hid the fact that this is awaitable at all.
  stop(closeActiveConnections?: boolean): Promise<void>;
  upgrade(request: Request, options?: { data?: unknown; headers?: Record<string, string> }): boolean;
  requestIP(request: Request): { address: string; family: string; port: number } | null;
}

/**
 * What {@link serveBun} hands back: Bun's own server, plus the bounded `close()` that
 * `app.close()` cannot provide here. `app.close()` returns at its `if (!server)` guard on Bun,
 * because a Bun app is served through `app.fetch` and never through `listen()`.
 */
export interface BunServeResult extends BunServer {
  /**
   * Drains in-flight requests, then force-closes whatever is left after `timeoutMs` (default:
   * 10s). Same meaning as `app.close({ timeoutMs })` on Node.
   */
  close(options?: { timeoutMs?: number }): Promise<void>;
}
interface BunServeOptions {
  port?: number;
  hostname?: string;
  fetch(request: Request, server: BunServer): Response | Promise<Response> | undefined;
  websocket?: BunWebSocketHandler;
}
type BunServeShortOptions = { port?: number; hostname?: string };
declare const Bun: { serve(options: BunServeOptions): BunServer };

/** Per-connection state stashed on ws.data between fetch (upgrade) and the open/message/close callbacks. */
interface BunConnData {
  wsReq: WsRequest;
  inbound: Channel<unknown>;
  ac: AbortController;
}

/**
 * Wraps a Bun ServerWebSocket as a neutral WsSocket. Unlike Deno/edge, Bun delivers socket
 * events to a server-level handler rather than the socket, so the channel and abort are
 * created during the upgrade and stashed on ws.data — there is nothing here to wire up.
 */
function bunSocket(ws: BunServerWebSocket): WsSocket {
  const { inbound, ac } = ws.data as BunConnData;

  return neutralSocket(ws, inbound, ac);
}

/**
 * Serve a Green Tea app on Bun: HTTP + SSE via app.fetch, WebSocket via Bun's server-level
 * websocket handler. The ServerWebSocket only exists in open(), so per-connection state
 * (inbound channel, abort, WsRequest) is stashed on ws.data during the upgrade.
 * Bun.serve exposes no equivalent to Node's server.maxConnections; enforce connection caps at
 * the deployment platform or reverse proxy.
 */
export function serveBun(app: App, options?: BunServeShortOptions): BunServeResult {
  const server = Bun.serve({
    ...options,
    fetch(request, server) {
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const inbound = channel();
        const ac = new AbortController();
        const wsReq = toWsRequest(request, server.requestIP(request)?.address ?? '');
        const data: BunConnData = { wsReq, inbound, ac };
        if (server.upgrade(request, { data })) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return app.fetch(request);
    },
    websocket: {
      open(ws) {
        const { wsReq } = ws.data as BunConnData;

        void upgradeSafely(app, wsReq, bunSocket(ws));
      },
      message(ws, message) {
        const { inbound } = ws.data as BunConnData;

        inbound.push(decodeMessage(message));
      },
      close(ws) {
        const { inbound, ac } = ws.data as BunConnData;
        inbound.close();
        ac.abort();
      },
      error(ws) {
        const { inbound, ac } = ws.data as BunConnData;
        inbound.fail(new Error('websocket error'));
        ac.abort();
      },
    },
  });

  // Object.assign rather than a fresh object: Bun.serve returns more than the ambient above
  // declares (reload, ref, unref, …), and rebuilding would silently drop whatever we did not name.
  return Object.assign(server, {
    close: (closeOptions: { timeoutMs?: number } = {}): Promise<void> =>
      closeWithDeadline(
        () => server.stop(false),
        () => void server.stop(true),
        closeOptions.timeoutMs ?? 10_000,
        (ms) =>
          app.logger.warn(`graceful shutdown timed out after ${ms}ms — forcing remaining connections closed`, {
            timeoutMs: ms,
            runtime: 'bun',
          }),
      ),
  });
}

import type http from 'http';
import { channel } from '../channel';
import type { Bus } from '../bus';
import {
  runWsConnection,
  matchWsRoute,
  trackUntil,
  boundInbound,
  controlLimits,
  wsMessageBytes,
  type WsSocket,
  type WsRequest,
} from './ws-core';
import type { WsRouteDef, MeshControl, RequestLimits } from './types';
import { normalizeRequestPath } from './router';
import { nodeRequire } from '../node-require';
import { MESH_CONTROL_DISABLED_REASON, MESH_CONTROL_PATH } from '../mesh/teapot';

/** Lazily loads the optional `ws` peer dependency's `WebSocketServer`, or null when it is not installed. */
function loadWss(): any | null {
  try {
    // `ws` is an OPTIONAL peer dependency: lazy-required so installs without WebSocket
    // support don't fail. When absent this throws and we fall back to null (501 on upgrade).
    return nodeRequire<{ WebSocketServer: unknown }>('ws').WebSocketServer;
  } catch {
    return null;
  }
}

/** Writes a bodyless HTTP status to the raw socket and destroys it. */
function rejectUpgrade(socket: any, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Handles the mesh-control upgrade path; returns true when the request was for the mesh control endpoint. */
function handleMeshUpgrade(
  wss: any,
  meshControl: MeshControl,
  path: string,
  req: http.IncomingMessage,
  socket: any,
  head: Buffer,
  streams?: Set<() => void>,
  limits?: RequestLimits,
): boolean {
  if (path !== meshControl.path) return false;

  if (!wss) {
    rejectUpgrade(socket, 501, 'Not Implemented');
    return true;
  }

  // An RPC carries a whole request body, so the channel is bounded by the teapot's body limit
  // rather than `maxWsMessageBytes` (#120). `wss` is built with that bound as `maxPayload`, and
  // `boundInbound` repeats it on the decoded text, as it does for every route.
  const bounds = controlLimits(limits, meshControl.maxFrameBytes);

  // nodeSocket, not the raw ws: the control channel is the last consumer that spoke the
  // `ws` EventEmitter API directly. It now takes the same neutral socket every route does.
  // Tracked like any other long-lived socket: a connected teacup has no reason to hang up, so
  // an untracked control channel leaves the teapot's server.close() waiting on it forever.
  // serveFrames swallows its own failures, so the floating promise cannot reject.
  wss.handleUpgrade(req, socket, head, (ws: any) => {
    const neutral = boundInbound(nodeSocket(ws), bounds);

    void trackUntil(neutral, meshControl.handle(neutral), streams);
  });
  return true;
}

/** Accepts an upgrade to the reserved mesh path on an app without a control channel, then closes it 1008. */
function refuseMeshUpgrade(wss: any, req: http.IncomingMessage, socket: any, head: Buffer): void {
  if (!wss) {
    rejectUpgrade(socket, 501, 'Not Implemented');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: { close(code: number, reason: string): void }) =>
    ws.close(1008, MESH_CONTROL_DISABLED_REASON),
  );
}

/** Builds the neutral WsRequest from a Node upgrade request. Same values the old open() read from req.socket. */
function nodeWsRequest(req: http.IncomingMessage): WsRequest {
  return {
    url: req.url ?? '/',
    headers: req.headers,
    protocol: (req.socket as any).encrypted ? 'https' : 'http',
    ip: req.socket.remoteAddress ?? '',
  };
}

/** Wraps a `ws` socket as a neutral WsSocket: inbound channel + abort on close + send/close/terminate. */
function nodeSocket(ws: any): WsSocket {
  const inbound = channel<unknown>();
  const ac = new AbortController();
  ws.on('message', (data: Buffer) => inbound.push(data.toString()));
  ws.on('close', () => {
    inbound.close();
    ac.abort();
  });
  ws.on('error', (err: unknown) => inbound.fail(err));
  return {
    inbound,
    abort: ac.signal,
    get isOpen() {
      return ws.readyState === 1; // 1 = OPEN
    },
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        /* already closed */
      }
    },
    terminate: () => (ws.terminate ?? ws.close).call(ws),
  };
}

/** Attaches WebSocket upgrade handling to the server: routes to `wsRoutes` or a mesh control path. */
export function attachWs(
  server: http.Server,
  wsRoutes: WsRouteDef[],
  bus?: Bus,
  meshControl?: MeshControl,
  streams?: Set<() => void>,
  limits?: RequestLimits,
): void {
  if (wsRoutes.length === 0 && !meshControl) return;
  const WebSocketServer = loadWss();
  // `maxPayload` is the pre-buffer half of `maxWsMessageBytes`: `ws` refuses an oversized frame,
  // fragmented or not, before it is assembled, and closes 1009 itself. `boundInbound` repeats the
  // check on the decoded text, which is the only half Deno and the edge have.
  const wss = WebSocketServer ? new WebSocketServer({ noServer: true, maxPayload: wsMessageBytes(limits) }) : null;
  // The control channel's own server, so its larger bound (#120) never reaches a user route.
  const meshWss =
    WebSocketServer && meshControl
      ? new WebSocketServer({
          noServer: true,
          maxPayload: controlLimits(limits, meshControl.maxFrameBytes).maxWsMessageBytes,
        })
      : null;
  server.on('upgrade', (req, socket, head) => {
    // A peer that resets mid-rejection must not raise an unhandled 'error' on a socket nobody
    // else is listening to yet: that is as fatal as a throw.
    socket.on('error', () => {});

    // Nothing thrown in here may escape. This is a raw EventEmitter listener, so a throw is an
    // uncaught exception that takes the whole process down, not a 500 for one client.
    try {
      routeUpgrade({ wss, meshWss, wsRoutes, bus, meshControl, streams, limits }, req, socket, head);
    } catch {
      if (socket.writable) rejectUpgrade(socket, 500, 'Internal Server Error');
      else socket.destroy();
    }
  });
}

/** What every upgrade on one server shares. */
interface UpgradeEnv {
  wss: any;
  /** The mesh control channel's server, bounded by its own frame limit (#120). */
  meshWss: any;
  wsRoutes: WsRouteDef[];
  bus?: Bus;
  meshControl?: MeshControl;
  streams?: Set<() => void>;
  limits?: RequestLimits;
}

/** Routes one upgrade: validates the path the way HTTP does, then mesh control, then the ws route table. */
function routeUpgrade(env: UpgradeEnv, req: http.IncomingMessage, socket: any, head: Buffer): void {
  const { wss, meshWss, wsRoutes, bus, meshControl, streams, limits } = env;
  let path: string;

  // The same normalization the HTTP path runs (`dispatch` in core.ts). Without it a malformed
  // escape reaches `decodeURIComponent` in the matcher and throws, and `//` silently matches.
  try {
    path = normalizeRequestPath((req.url ?? '/').split('?')[0]);
  } catch {
    rejectUpgrade(socket, 400, 'Bad Request');
    return;
  }

  if (meshControl && handleMeshUpgrade(meshWss, meshControl, path, req, socket, head, streams, limits)) return;

  // The reserved path with no control channel: refused exactly as `app.upgrade` refuses it on Deno,
  // Bun and the edge — accept, then close 1008 with the same reason (D17). Never falls through to the
  // ws route table: the boot already refuses any route that claims this path.
  if (path === MESH_CONTROL_PATH) {
    refuseMeshUpgrade(wss, req, socket, head);
    return;
  }

  const route = matchWsRoute(wsRoutes, path);

  if (!route) {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  if (!wss) {
    rejectUpgrade(socket, 501, 'Not Implemented');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: any) => {
    void runWsConnection(boundInbound(nodeSocket(ws), limits), nodeWsRequest(req), route, bus, streams);
  });
}

import http from 'http';
import { channel } from '../channel';
import { isHttpError } from '../signals';
import type { Bus } from '../bus';
import { matchPattern } from './router';
import type { WsRouteDef, MeshControl } from './types';

/** Lazily loads the optional `ws` peer dependency's `WebSocketServer`, or null when it is not installed. */
function loadWss(): any | null {
  try {
    // `ws` is an OPTIONAL peer dependency: lazy-required so installs without WebSocket
    // support don't fail. When absent this throws and we fall back to null (501 on upgrade).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ws').WebSocketServer;
  } catch {
    return null;
  }
}

/** Writes a 501 Not Implemented status to the raw socket and destroys it. */
function reject501(socket: any): void {
  socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n');
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
): boolean {
  if (path !== meshControl.path) return false;

  if (!wss) {
    reject501(socket);
    return true;
  }

  wss.handleUpgrade(req, socket, head, (ws: any) => meshControl.handle(ws, req));
  return true;
}

/** Finds the first ws route whose pattern matches `path`, capturing its params. */
function matchWsRoute(
  wsRoutes: WsRouteDef[],
  path: string,
): { def: WsRouteDef; params: Record<string, string> | undefined } | undefined {
  return wsRoutes
    .map((candidate) => ({ def: candidate, params: matchPattern(candidate.pattern, path) }))
    .find((entry) => entry.params);
}

/** Wires inbound message/close/error events into a channel and returns the channel plus its abort controller. */
function wireInbound(ws: any): { inbound: ReturnType<typeof channel<unknown>>; abortController: AbortController } {
  const inbound = channel<unknown>();
  const abortController = new AbortController();
  ws.on('message', (data: Buffer) => inbound.push(data.toString()));
  ws.on('close', () => {
    inbound.close();
    abortController.abort();
  });
  ws.on('error', (err: unknown) => inbound.fail(err));

  return { inbound, abortController };
}

/** Registers the connection with the stream registry so it can be force-closed on shutdown. */
function trackConnection(ws: any, streams?: Set<() => void>): void {
  const closer = () => {
    try {
      (ws.terminate ?? ws.close).call(ws);
    } catch {
      /* */
    }
  };

  streams?.add(closer);
  ws.on('close', () => streams?.delete(closer));
}

/** Drives the outbound async iterator, sending each yielded value over the socket until done or closed. */
async function pumpOutbound(ws: any, iterator: AsyncIterator<unknown>): Promise<void> {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    if (ws.readyState !== 1) break; // 1 = OPEN; stop if socket gone
    ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  }

  try {
    ws.close();
  } catch {
    /* already closed */
  }
}

/** Closes the socket with the appropriate code after an outbound error (4000+status for HTTP errors, 1011 otherwise). */
function closeOnError(ws: any, err: unknown): void {
  if (isHttpError(err)) {
    const reason = Buffer.from(String(err.message)).subarray(0, 120).toString();

    try {
      ws.close(4000 + err.status, reason);
    } catch {
      /* already closed */
    }
  } else {
    try {
      ws.close(1011);
    } catch {
      /* already closed */
    }
  }
}

/** Runs the full per-connection lifecycle: inbound wiring, opening the route stream, and pumping outbound values. */
async function openWsConnection(
  ws: any,
  route: { def: WsRouteDef; params: Record<string, string> | undefined },
  req: http.IncomingMessage,
  bus?: Bus,
  streams?: Set<() => void>,
): Promise<void> {
  trackConnection(ws, streams);
  const { inbound, abortController } = wireInbound(ws);

  const name = route.def.pattern;
  let iterator: AsyncIterator<unknown> | undefined;
  ws.on('close', () => {
    void Promise.resolve(iterator?.return?.()).catch(() => {});
  }); // force-cancel outbound
  bus?.emit('stream:open', { name });

  try {
    const outbound = await route.def.open({ params: route.params!, inbound, abort: abortController.signal, req });
    iterator = outbound[Symbol.asyncIterator]();
    await pumpOutbound(ws, iterator);
  } catch (err) {
    bus?.emit('stream:error', { name, error: err });
    closeOnError(ws, err);
  } finally {
    abortController.abort();
    bus?.emit('stream:close', { name });
  }
}

/** Attaches WebSocket upgrade handling to the server: routes to `wsRoutes` or a mesh control path. */
export function attachWs(
  server: http.Server,
  wsRoutes: WsRouteDef[],
  bus?: Bus,
  meshControl?: MeshControl,
  streams?: Set<() => void>,
): void {
  if (wsRoutes.length === 0 && !meshControl) return;
  const WebSocketServer = loadWss();
  const wss = WebSocketServer ? new WebSocketServer({ noServer: true }) : null;
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];

    if (meshControl && handleMeshUpgrade(wss, meshControl, path, req, socket, head)) return;

    const route = matchWsRoute(wsRoutes, path);

    if (!route) {
      socket.destroy();
      return;
    }

    if (!wss) {
      reject501(socket);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: any) => openWsConnection(ws, route, req, bus, streams));
  });
}

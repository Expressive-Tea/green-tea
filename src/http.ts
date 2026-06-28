import http from 'http';
import { once } from 'events';
import { channel } from './channel';
import { errorToResponse } from './transformers';
import { HttpError } from './signals';
import { sseEncoder, ndjsonEncoder, StreamEncoder } from './encoders';
import { isStreamResult, type PipelineResult, type ResponseShape } from './pipeline';
import type { Transport } from './metadata';
import type { Bus } from './bus';

export interface RequestLimits {
  maxBodyBytes?: number;       // default 1_000_000
  requestTimeoutMs?: number;   // default 30_000
  headersTimeoutMs?: number;   // default 10_000
  keepAliveTimeoutMs?: number; // default 5_000
}
export interface HttpOptions { limits?: RequestLimits; streams?: Set<() => void> }

export type RouteHandler = (req: {
  method: string; url: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}) => Promise<PipelineResult>;

export interface RouteDef { method: string; pattern: string; transport: Transport; handler: RouteHandler }
export interface MatchedRoute { params: Record<string, string>; def: RouteDef }

export interface WsOpenCtx {
  params: Record<string, string>;
  inbound: AsyncIterable<unknown>;
  abort: AbortSignal;
  req: http.IncomingMessage;
}
export interface WsRouteDef { pattern: string; open: (ctx: WsOpenCtx) => Promise<AsyncIterable<unknown>> }

export interface MeshControl { path: string; handle(ws: any, req: http.IncomingMessage): void }

const PING_MS = 15_000;

export function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const segs = path.split('/').filter(Boolean);
  const pat = pattern.split('/').filter(Boolean);
  if (pat.length !== segs.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith(':')) params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (pat[i] !== segs[i]) return undefined;
  }
  return params;
}

export function matchRoute(routes: RouteDef[], method: string, path: string): MatchedRoute | undefined {
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchPattern(r.pattern, path);
    if (params) return { params, def: r };
  }
  return undefined;
}

export function parseQuery(url: string): Record<string, string> {
  const qs = url.split('?')[1] ?? '';
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(qs)) out[k] = v;
  return out;
}

async function readBody(req: http.IncomingMessage, maxBodyBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBodyBytes) throw new HttpError(413, 'Payload Too Large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? undefined : raw;
}

function pickEncoder(transport: Transport, accept: string): StreamEncoder {
  if (transport === 'sse') return sseEncoder;
  if (transport === 'ndjson') return ndjsonEncoder;
  return accept.includes('text/event-stream') ? sseEncoder : ndjsonEncoder;
}

async function pipeStream(
  res: http.ServerResponse, stream: AsyncIterable<unknown>, encoder: StreamEncoder,
  bus?: Bus, name = '', streams?: Set<() => void>,
): Promise<void> {
  res.writeHead(200, encoder.headers);
  bus?.emit('stream:open', { name });
  const it = stream[Symbol.asyncIterator]();
  let ping: ReturnType<typeof setInterval> | undefined;
  if (encoder.ping) { ping = setInterval(() => res.write(encoder.ping!()), PING_MS); ping.unref?.(); }
  const stop = () => { if (ping) clearInterval(ping); void Promise.resolve(it.return?.()).catch(() => {}); };
  res.on('close', stop);
  const closer = () => { try { res.destroy(); } catch { /* */ } };
  streams?.add(closer);
  const onClose = once(res, 'close');
  try {
    while (true) {
      const { value, done } = await it.next();
      if (done) break;
      if (!res.write(encoder.encode(value))) {
        await Promise.race([once(res, 'drain'), onClose]);
        if (res.destroyed) break;   // let finally clean up
      }
    }
  } catch (err) {
    bus?.emit('stream:error', { name, error: err });
    const frame = encoder.encodeError(err);
    if (frame && !res.writableEnded) res.write(frame);
  } finally {
    if (ping) clearInterval(ping);
    streams?.delete(closer);
    if (!res.writableEnded && !res.destroyed) res.end();
    bus?.emit('stream:close', { name });
  }
}

function loadWss(): any | null {
  try { return require('ws').WebSocketServer; } catch { return null; }
}

function attachWs(
  server: http.Server, wsRoutes: WsRouteDef[], bus?: Bus, meshControl?: MeshControl, streams?: Set<() => void>,
): void {
  if (wsRoutes.length === 0 && !meshControl) return;
  const WSS = loadWss();
  const wss = WSS ? new WSS({ noServer: true }) : null;
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '/').split('?')[0];
    if (meshControl && path === meshControl.path) {
      if (!wss) { socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws: any) => meshControl.handle(ws, req));
      return;
    }
    const route = wsRoutes.map((r) => ({ r, params: matchPattern(r.pattern, path) })).find((x) => x.params);
    if (!route) { socket.destroy(); return; }
    if (!wss) { socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, async (ws: any) => {
      const closer = () => { try { (ws.terminate ?? ws.close).call(ws); } catch { /* */ } };
      streams?.add(closer);
      ws.on('close', () => streams?.delete(closer));
      const inbound = channel<unknown>();
      const ac = new AbortController();
      ws.on('message', (d: Buffer) => inbound.push(d.toString()));
      ws.on('close', () => { inbound.close(); ac.abort(); });
      ws.on('error', (e: unknown) => inbound.fail(e));

      const name = route.r.pattern;
      let it: AsyncIterator<unknown> | undefined;
      ws.on('close', () => { void Promise.resolve(it?.return?.()).catch(() => {}); }); // force-cancel outbound
      bus?.emit('stream:open', { name });
      try {
        const out = await route.r.open({ params: route.params!, inbound, abort: ac.signal, req });
        it = out[Symbol.asyncIterator]();
        while (true) {
          const { value, done } = await it.next();
          if (done) break;
          if (ws.readyState !== 1) break;   // 1 = OPEN; stop if socket gone
          ws.send(typeof value === 'string' ? value : JSON.stringify(value));
        }
        try { ws.close(); } catch { /* already closed */ }
      } catch (err) {
        bus?.emit('stream:error', { name, error: err });
        try { ws.close(1011); } catch { /* already closed */ }
      } finally {
        ac.abort();
        bus?.emit('stream:close', { name });
      }
    });
  });
}

export function createHttpServer(
  routes: RouteDef[], wsRoutes: WsRouteDef[] = [], bus?: Bus, meshControl?: MeshControl, opts?: HttpOptions,
): http.Server {
  const maxBody = opts?.limits?.maxBodyBytes ?? 1_000_000;
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    const matched = matchRoute(routes, req.method ?? 'GET', path);
    if (!matched) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    let raw: string | undefined;
    try {
      raw = await readBody(req, maxBody);
    } catch (error) {
      const r = errorToResponse(error);
      res.writeHead(r.status, { ...r.headers, connection: 'close' });
      res.end(r.body);
      return;
    }
    let body: unknown = raw;
    const ct = String(req.headers['content-type'] ?? '');
    if (raw !== undefined && ct.includes('application/json')) {
      try { body = JSON.parse(raw); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
    }
    let result: PipelineResult;
    try {
      result = await matched.def.handler({
        method: req.method ?? 'GET', url, headers: req.headers,
        params: matched.params, query: parseQuery(url), body,
      });
    } catch (error) {
      result = errorToResponse(error);
    }
    if (isStreamResult(result)) {
      const encoder = pickEncoder(matched.def.transport, String(req.headers.accept ?? ''));
      await pipeStream(res, result.stream, encoder, bus, matched.def.pattern, opts?.streams);
      return;
    }
    const r: ResponseShape = result;
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  server.requestTimeout = opts?.limits?.requestTimeoutMs ?? 30_000;
  server.headersTimeout = opts?.limits?.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = opts?.limits?.keepAliveTimeoutMs ?? 5_000;
  attachWs(server, wsRoutes, bus, meshControl, opts?.streams);
  return server;
}

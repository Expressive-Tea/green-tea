import http from 'http';
import https from 'https';
import { once } from 'events';
import { channel } from './channel';
import { errorToResponse } from './transformers';
import { HttpError, isHttpError } from './signals';
import { sseEncoder, ndjsonEncoder, StreamEncoder } from './encoders';
import { isStreamResult, type PipelineResult, type ResponseShape } from './pipeline';
import type { Transport } from './metadata';
import type { Bus } from './bus';
import { buildSecurityHeaders, mergeVary } from './security';
import type { TlsOptions, SecurityOptions } from './security';

export interface RequestLimits {
  maxBodyBytes?: number;       // default 1_000_000
  requestTimeoutMs?: number;   // default 30_000
  headersTimeoutMs?: number;   // default 10_000
  keepAliveTimeoutMs?: number; // default 5_000
}
export interface HttpOptions { limits?: RequestLimits; streams?: Set<() => void>; tls?: TlsOptions; trustProxy?: boolean; security?: boolean | SecurityOptions }

export type RouteHandler = (req: {
  method: string; url: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  protocol: 'http' | 'https';
  ip: string;
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

function firstToken(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.split(',')[0].trim();
}
function deriveSecure(req: http.IncomingMessage, trustProxy: boolean): boolean {
  if (trustProxy) { const p = firstToken(req.headers['x-forwarded-proto']); if (p) return p === 'https'; }
  return (req.socket as any).encrypted === true;
}
function deriveIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) { const f = firstToken(req.headers['x-forwarded-for']); if (f) return f; }
  return req.socket.remoteAddress ?? '';
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
  res.flushHeaders();   // establish the stream immediately so idle-until-event sources (e.g. subscriptions) don't deadlock clients awaiting headers
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
        if (isHttpError(err)) {
          const reason = Buffer.from(String(err.message)).subarray(0, 120).toString();
          try { ws.close(4000 + err.status, reason); } catch { /* already closed */ }
        } else {
          try { ws.close(1011); } catch { /* already closed */ }
        }
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
  const trustProxy = opts?.trustProxy ?? false;
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    // Install the security-header patch BEFORE any routing/response so every path
    // (200, 404, error, stream) writes headers through the same patched writeHead.
    const secure = deriveSecure(req, trustProxy);
    const injected: Record<string, string> = { ...buildSecurityHeaders(opts?.security ?? true, secure) };
    // (CORS is folded into `injected` in Task 5; this task is security headers only.)
    const orig = res.writeHead.bind(res);
    (res as any).writeHead = (status: number, arg2?: any, arg3?: any) => {
      // normalize (statusMessage?, headers?) overloads
      const hdrs = (typeof arg2 === 'string' ? arg3 : arg2) as Record<string, any> | undefined;
      // injected (security/CORS) is authoritative. Node's writeHead does NOT dedupe case-variant
      // keys — both lines would ship and a browser honors the first — so drop any handler header
      // whose name case-insensitively collides with an injected one before merging.
      const merged: Record<string, any> = {};
      const injectedLower = new Set(Object.keys(injected).map((k) => k.toLowerCase()));
      let handlerVary: string | undefined;
      if (hdrs) for (const k of Object.keys(hdrs)) {
        const lk = k.toLowerCase();
        if (lk === 'vary') { handlerVary = hdrs[k]; continue; }        // merged separately below
        if (!injectedLower.has(lk)) merged[k] = hdrs[k];
      }
      Object.assign(merged, injected);
      if (injected['vary']) merged['vary'] = mergeVary(handlerVary, injected['vary']);
      else if (handlerVary !== undefined) merged['vary'] = handlerVary; // preserve handler Vary when no CORS
      return typeof arg2 === 'string' ? orig(status, arg2, merged) : orig(status, merged);
    };
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
    } else if (raw !== undefined && ct.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    let result: PipelineResult;
    try {
      result = await matched.def.handler({
        method: req.method ?? 'GET', url, headers: req.headers,
        params: matched.params, query: parseQuery(url), body,
        protocol: secure ? 'https' : 'http', ip: deriveIp(req, trustProxy),
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
  };
  // runtime-compatible; only @types differ (https.Server lacks the http-only timeout props)
  const server: http.Server = (opts?.tls
    ? https.createServer(opts.tls as https.ServerOptions, handler)
    : http.createServer(handler)) as unknown as http.Server;
  server.requestTimeout = opts?.limits?.requestTimeoutMs ?? 30_000;
  server.headersTimeout = opts?.limits?.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = opts?.limits?.keepAliveTimeoutMs ?? 5_000;
  attachWs(server, wsRoutes, bus, meshControl, opts?.streams);
  return server;
}

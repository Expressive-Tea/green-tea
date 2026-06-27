import http from 'http';
import { once } from 'events';
import { errorToResponse } from './transformers';
import { sseEncoder, ndjsonEncoder, StreamEncoder } from './encoders';
import { isStreamResult, type PipelineResult, type ResponseShape } from './pipeline';
import type { Transport } from './metadata';
import type { Bus } from './bus';

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

async function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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
  bus?: Bus, name = '',
): Promise<void> {
  res.writeHead(200, encoder.headers);
  bus?.emit('stream:open', { name });
  const it = stream[Symbol.asyncIterator]();
  let ping: ReturnType<typeof setInterval> | undefined;
  if (encoder.ping) { ping = setInterval(() => res.write(encoder.ping!()), PING_MS); ping.unref?.(); }
  const stop = () => { if (ping) clearInterval(ping); void it.return?.(); };
  res.on('close', stop);
  try {
    while (true) {
      const { value, done } = await it.next();
      if (done) break;
      if (!res.write(encoder.encode(value))) await once(res, 'drain');
    }
  } catch (err) {
    bus?.emit('stream:error', { name, error: err });
    const frame = encoder.encodeError(err);
    if (frame && !res.writableEnded) res.write(frame);
  } finally {
    if (ping) clearInterval(ping);
    if (!res.writableEnded) res.end();
    bus?.emit('stream:close', { name });
  }
}

export function createHttpServer(routes: RouteDef[], wsRoutes: WsRouteDef[] = [], bus?: Bus): http.Server {
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
      raw = await readBody(req);
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
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
      await pipeStream(res, result.stream, encoder, bus, matched.def.pattern);
      return;
    }
    const r: ResponseShape = result;
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  return server;   // Task 7 will insert `attachWs(server, wsRoutes);` before this line
}

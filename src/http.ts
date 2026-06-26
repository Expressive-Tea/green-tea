import http from 'http';
import { errorToResponse } from './transformers';
import type { ResponseShape } from './pipeline';

export type RouteHandler = (req: {
  method: string; url: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}) => Promise<ResponseShape>;

export interface RouteDef { method: string; pattern: string; handler: RouteHandler }
export interface MatchedRoute { params: Record<string, string>; handler: RouteHandler }

export function matchRoute(routes: RouteDef[], method: string, path: string): MatchedRoute | undefined {
  const segs = path.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const pat = r.pattern.split('/').filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(':')) params[pat[i].slice(1)] = decodeURIComponent(segs[i]);
      else if (pat[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return { params, handler: r.handler };
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

export function createHttpServer(routes: RouteDef[]): http.Server {
  return http.createServer(async (req, res) => {
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
      // stream/network failure — not the client's JSON fault
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
      return;
    }
    let body: unknown = raw;
    const ct = String(req.headers['content-type'] ?? '');
    if (raw !== undefined && ct.includes('application/json')) {
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
    }
    let result: ResponseShape;
    try {
      result = await matched.handler({
        method: req.method ?? 'GET', url, headers: req.headers,
        params: matched.params, query: parseQuery(url), body,
      });
    } catch (error) {
      result = errorToResponse(error);
    }
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  });
}

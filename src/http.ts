import http from 'http';
import type { ResponseShape } from './pipeline';

export type RouteHandler = (req: {
  method: string; url: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
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

export function createHttpServer(routes: RouteDef[]): http.Server {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const matched = matchRoute(routes, req.method ?? 'GET', path);
    if (!matched) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
    const result = await matched.handler({
      method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, params: matched.params,
    });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  });
}

/**
 * The application-level fetch fixtures, free of vitest and of any runtime API, so the same app and
 * requests run through `app.fetch` on Node, Deno, Bun and workerd. `app.test.ts` and
 * `owner.test.ts` use them with the frozen files; the runtime runners call {@link runAppDifferential}.
 */
import 'reflect-metadata';
import { createApp, Route, Get, Head, Post, Put, Patch, Delete, Options, Sse, Module, param } from '../../src/index';
import type { App } from '../../src/app/types';
import type { FrozenLoader } from './differential';

const reply = (id: string, params: Record<string, string>) => ({ id, params });

// Ordered on purpose: the overlapping declarations are registered least-specific first, so a
// lookup that fell back to registration order would answer differently from one that ranks.
@Route('/')
class ParityHttp {
  @Get('/a/:rest*') aRest(@param() p: Record<string, string>) {
    return reply('aRest', p);
  }
  @Get('/a/:id') aId(@param() p: Record<string, string>) {
    return reply('aId', p);
  }
  @Get('/a/b') aB(@param() p: Record<string, string>) {
    return reply('aB', p);
  }
  @Get('/users/:value') usersValue(@param() p: Record<string, string>) {
    return reply('usersValue', p);
  }
  @Get('/users/:id(\\d+)') usersId(@param() p: Record<string, string>) {
    return reply('usersId', p);
  }
  @Get('/n/:num(\\d+)') nNum(@param() p: Record<string, string>) {
    return reply('nNum', p);
  }
  @Get('/n/:code([0-9a-f]+)') nCode(@param() p: Record<string, string>) {
    return reply('nCode', p);
  }
  @Get('/files') files(@param() p: Record<string, string>) {
    return reply('files', p);
  }
  @Get('/files/:rest*') filesRest(@param() p: Record<string, string>) {
    return reply('filesRest', p);
  }
  @Get('/m') mGet(@param() p: Record<string, string>) {
    return reply('mGet', p);
  }
  @Post('/m') mPost(@param() p: Record<string, string>) {
    return reply('mPost', p);
  }
  @Get('/h') hGet(@param() p: Record<string, string>) {
    return reply('hGet', p);
  }
  @Head('/h') hHead(@param() p: Record<string, string>) {
    return reply('hHead', p);
  }
  @Sse('/stream') stream() {
    return (async function* () {
      yield { id: 'stream' };
    })();
  }
  @Sse('/s/live') sLive() {
    return (async function* () {
      yield { id: 'sLive' };
    })();
  }
  @Get('/s/:id') sId(@param() p: Record<string, string>) {
    return reply('sId', p);
  }
  @Get('/Case') caseUpper(@param() p: Record<string, string>) {
    return reply('caseUpper', p);
  }
  @Get('/u/:name') uName(@param() p: Record<string, string>) {
    return reply('uName', p);
  }
  @Get('/admin') admin(@param() p: Record<string, string>) {
    return reply('admin', p);
  }
  @Get('/public/:file') publicFile(@param() p: Record<string, string>) {
    return reply('publicFile', p);
  }
  @Delete('/r') rDelete(@param() p: Record<string, string>) {
    return reply('rDelete', p);
  }
  @Patch('/r') rPatch(@param() p: Record<string, string>) {
    return reply('rPatch', p);
  }
  @Options('/r') rOptions(@param() p: Record<string, string>) {
    return reply('rOptions', p);
  }
  @Put('/r') rPut(@param() p: Record<string, string>) {
    return reply('rPut', p);
  }
  @Get('/') root(@param() p: Record<string, string>) {
    return reply('root', p);
  }
}

@Module({ mountpoint: '/', controllers: [ParityHttp] })
export class ParityHttpModule {}

export type Req = [method: string, raw: string];

export const REQUESTS: Req[] = [
  ['GET', '/a/b'],
  ['GET', '/a/x'],
  ['GET', '/a/x/y'],
  ['GET', '/a'],
  ['GET', '/users/42'],
  ['GET', '/users/alice'],
  ['GET', '/users/a%20b'],
  ['GET', '/n/42'],
  ['GET', '/n/ff'],
  ['GET', '/files'],
  ['GET', '/files/'],
  ['GET', '/files/a%2Fb'],
  ['GET', '/m'],
  ['HEAD', '/m'],
  ['OPTIONS', '/m'],
  ['PUT', '/m'],
  ['DELETE', '/m'],
  ['POST', '/m'],
  ['GET', '/h'],
  ['HEAD', '/h'],
  ['GET', '/stream'],
  ['HEAD', '/stream'],
  ['OPTIONS', '/stream'],
  ['HEAD', '/s/live'],
  ['HEAD', '/s/x'],
  ['GET', '/absent'],
  ['HEAD', '/absent'],
  ['OPTIONS', '/absent'],
  ['GET', '/users/%E0%A4%A'],
  ['HEAD', '/users/%E0%A4%A'],
  ['GET', '/a//b'],
  ['GET', '/Case'],
  ['GET', '/case'],
  ['GET', '/caf%C3%A9'],
  ['GET', '/u/caf%C3%A9'],
  ['GET', '/public/../admin'],
  ['GET', '/public/%2e%2e/admin'],
  ['GET', '/public/..%2fadmin'],
  ['GET', '/admin/'],
  ['OPTIONS', '/r'],
  ['HEAD', '/r'],
  ['GET', '/r'],
  ['PURGE', '/r'], // TRACE is a forbidden method for `new Request`
  ['GET', '/'],
  ['GET', '/?q=1'],
];

/** Headers that vary per run or per connection rather than per route decision. */
const VOLATILE = new Set(['date', 'connection', 'keep-alive', 'x-request-id']);

export function stableHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of [...entries].sort(([a], [b]) => a.localeCompare(b)))
    if (!VOLATILE.has(name)) out[name] = value;
  return out;
}

export interface Observed {
  method: string;
  raw: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function viaFetch(app: App, [method, raw]: Req): Promise<Observed> {
  // `new Request` applies the URL parser first — exactly what Deno, Bun and workerd do.
  const res = await app.fetch(new Request(`http://parity.test${raw}`, { method }));
  return { method, raw, status: res.status, headers: stableHeaders(res.headers), body: await res.text() };
}

// `/ca` is GET :id + POST b; `/cb` adds DELETE :rest*. Two prefixes because one app cannot hold both
// variants at the same path.
@Route('/')
class CrossAllow {
  @Get('/ca/:id') caGet(@param() p: Record<string, string>) {
    return { id: 'caGet', p };
  }
  @Post('/ca/b') caPost() {
    return { id: 'caPost' };
  }
  @Get('/cb/:id') cbGet(@param() p: Record<string, string>) {
    return { id: 'cbGet', p };
  }
  @Post('/cb/b') cbPost() {
    return { id: 'cbPost' };
  }
  @Delete('/cb/:rest*') cbDelete(@param() p: Record<string, string>) {
    return { id: 'cbDelete', p };
  }
}
@Module({ mountpoint: '/', controllers: [CrossAllow] })
export class CrossAllowModule {}

export const ALLOW_REQUESTS: Array<[string, string]> = ['/ca', '/cb'].flatMap((base): Array<[string, string]> => [
  ['PUT', `${base}/b`],
  ['OPTIONS', `${base}/b`],
  ['PUT', `${base}/x`],
  ['HEAD', `${base}/b`],
  ['PUT', `${base}/x/y`],
]);

export interface Seen {
  method: string;
  path: string;
  status: number;
  allow: string | null;
  body: string;
}

export async function fetchRequest(app: App, method: string, path: string): Promise<Seen> {
  const res = await app.fetch(new Request(`http://parity.test${path}`, { method }));
  return { method, path, status: res.status, allow: res.headers.get('allow'), body: await res.text() };
}

/**
 * Runs the frozen `app.fetch` cases — `app-fetch.json` and the fetch rows of `owner-app-allow.json`
 * — on whatever runtime calls it, and returns every mismatch.
 */
export async function runAppDifferential(load: FrozenLoader): Promise<{ requests: number; mismatches: string[] }> {
  const mismatches: string[] = [];
  const parity = createApp({ modules: [ParityHttpModule] });
  const appFetch = ((await load('app-fetch')) as { data: Observed[] }).data;
  for (const [index, req] of REQUESTS.entries()) {
    const seen = await viaFetch(parity, req);
    if (JSON.stringify(seen) !== JSON.stringify(appFetch[index])) mismatches.push(`app-fetch ${req[0]} ${req[1]}`);
  }

  const cross = createApp({ modules: [CrossAllowModule] });
  const allow = ((await load('owner-app-allow')) as { data: Array<Seen & { adapter: string }> }).data;
  const fetchRows = allow.filter((row) => row.adapter === 'fetch');
  for (const [index, [method, path]] of ALLOW_REQUESTS.entries()) {
    const seen = { adapter: 'fetch', ...(await fetchRequest(cross, method, path)) };
    if (JSON.stringify(seen) !== JSON.stringify(fetchRows[index])) mismatches.push(`owner-app-allow ${method} ${path}`);
  }

  return { requests: REQUESTS.length + ALLOW_REQUESTS.length, mismatches };
}

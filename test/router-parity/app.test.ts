/**
 * Application-level router parity: what a client sees through `app.fetch` and through a real Node
 * socket — status, `Allow`, response headers, and HEAD body suppression. Matcher equality alone
 * cannot prove these: the 404/405/OPTIONS decisions, the 400 for a bad path and the HEAD body rule
 * live in `src/http/core.ts`, around the matcher.
 */
import 'reflect-metadata';
import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, beforeAll, afterAll } from 'vitest';
import { createApp, Route, Get, Head, Post, Put, Patch, Delete, Options, Sse, Module, param } from '../../src/index';
import type { App } from '../../src/app/types';
import { frozen, expectFrozenEqual } from './frozen';

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
class ParityHttpModule {}

type Req = [method: string, raw: string];

const REQUESTS: Req[] = [
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

function stableHeaders(entries: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of [...entries].sort(([a], [b]) => a.localeCompare(b)))
    if (!VOLATILE.has(name)) out[name] = value;
  return out;
}

interface Observed {
  method: string;
  raw: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function viaFetch(app: App, [method, raw]: Req): Promise<Observed> {
  // `new Request` applies the URL parser first — exactly what Deno, Bun and workerd do.
  const res = await app.fetch(new Request(`http://parity.test${raw}`, { method }));
  return { method, raw, status: res.status, headers: stableHeaders(res.headers), body: await res.text() };
}

function viaNode(port: number, [method, raw]: Req): Promise<Observed> {
  // `http.request` sends the path bytes as given, so the server sees the raw target.
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: raw, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        const headers = Object.entries(res.headers).map(([k, v]): [string, string] => [
          k,
          Array.isArray(v) ? v.join(', ') : String(v),
        ]);
        resolve({ method, raw, status: res.statusCode ?? 0, headers: stableHeaders(headers), body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('router parity: application-level HTTP outcomes', () => {
  let fetchApp: App;
  let nodeApp: App;
  let port: number;

  beforeAll(async () => {
    fetchApp = createApp({ modules: [ParityHttpModule] });
    nodeApp = createApp({ modules: [ParityHttpModule] });
    const server = await nodeApp.listen(0);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await nodeApp.close();
  });

  it('app.fetch outcomes equal the frozen capture', async () => {
    const run = async () => {
      const out: Observed[] = [];
      for (const req of REQUESTS) out.push(await viaFetch(fetchApp, req));
      return out;
    };
    const expected = await frozen('app-fetch', run);
    expectFrozenEqual(await run(), expected, 'app.fetch');
  });

  it('Node listener outcomes equal the frozen capture', async () => {
    const run = async () => {
      const out: Observed[] = [];
      for (const req of REQUESTS) out.push(await viaNode(port, req));
      return out;
    };
    const expected = await frozen('app-node', run);
    expectFrozenEqual(await run(), expected, 'node listener');
  });
});

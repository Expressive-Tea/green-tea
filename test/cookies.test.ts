// CARD-14 (#113): reading cookies with @cookie/@cookies, writing them with setCookie, and more than
// one Set-Cookie line per response on the Node adapter and app.fetch. Deno, Bun and edge repeat the
// two-line cases in test/deno/cookies.test.ts, test/bun/cookies.test.ts and test/edge/run.ts.
import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { describe, expect, it, afterAll } from 'vitest';
import {
  createApp,
  Route,
  Get,
  Ws,
  Module,
  Transformer,
  HttpError,
  needs,
  cookie,
  cookies,
  setCookie,
  parseCookies,
  type TransformerFn,
} from '../src/index';

const C1 = setCookie('a', '1');
const C2 = setCookie('b', '2', { maxAge: 60 });

const twoCookies: TransformerFn = (value) => ({
  status: 200,
  headers: { 'content-type': 'application/json', 'set-cookie': [C1, C2] },
  body: JSON.stringify(value),
});

@Route('/c')
class CookieCtl {
  @Get('/one')
  one(@cookie('a') a: string | undefined, @cookie('b') b: string | undefined) {
    return { a: a ?? null, b: b ?? null };
  }

  @Get('/all')
  all(@cookies() all: Record<string, string>) {
    return { all, keys: Object.keys(all) };
  }

  @Get('/pick')
  pick(@cookies(['d', 'e']) picked: Record<string, string>) {
    return picked;
  }

  @Get('/needs')
  viaNeeds(@needs('cookies') jar: Record<string, string>) {
    return { sid: jar.sid ?? null };
  }

  @Get('/transformer')
  @Transformer(twoCookies)
  transformer() {
    return { ok: true };
  }

  @Get('/error')
  error() {
    throw new HttpError(401, 'nope', undefined, { 'set-cookie': [C1, C2] });
  }

  @Get('/custom')
  @Transformer((v) => ({ headers: { 'x-custom': ['a', 'b'], vary: ['Accept', 'Accept-Language'] }, body: String(v) }))
  custom() {
    return 'x';
  }

  @Get('/renderer')
  renderer() {
    throw new Error('render me');
  }

  @Ws('/ws')
  ws(@cookie('a') a: string | undefined) {
    return (async function* () {
      yield `a=${a}`;
    })();
  }
}

@Module({ mountpoint: '/', controllers: [CookieCtl] })
class M {}

const app = createApp({
  modules: [M],
  cors: { origins: ['http://ok.test'] },
  onError: (error) =>
    error instanceof Error && error.message === 'render me'
      ? { status: 418, headers: { 'content-type': 'text/plain', 'set-cookie': [C1, C2] }, body: 'teapot' }
      : undefined,
});

let server: http.Server;
let port: number;

afterAll(() => server?.close());

async function boot(): Promise<void> {
  if (server) return;
  server = await app.listen(0);
  port = (server.address() as AddressInfo).port;
}

/** A raw request, so repeated header lines are visible as they came off the socket. */
async function raw(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; lines: [string, string][]; body: string }> {
  await boot();
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const lines: [string, string][] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            lines.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
          resolve({ status: res.statusCode!, lines, body });
        });
      })
      .on('error', reject);
  });
}

const valuesOf = (lines: [string, string][], name: string) => lines.filter(([k]) => k === name).map(([, v]) => v);
const fetchVia = (path: string, headers: Record<string, string> = {}) =>
  app.fetch(new Request(`http://x${path}`, { headers }));

describe('parseCookies', () => {
  it('T1: first value wins, %-sequences decode', () => {
    expect(parseCookies('a=1; a=2; b=%41')).toEqual({ a: '1', b: 'A' });
  });

  it('T2: malformed pairs are skipped, an undecodable value is kept raw', () => {
    expect({ ...parseCookies('=x; c; d=%ZZ; e=5') }).toEqual({ d: '%ZZ', e: '5' });
  });

  it('T3: no header is an empty map', () => {
    expect({ ...parseCookies(undefined) }).toEqual({});
  });

  it('joins several cookie lines (HTTP/2, proxies) with "; "', () => {
    expect({ ...parseCookies(['a=1', 'b=2; a=3']) }).toEqual({ a: '1', b: '2' });
  });

  it('treats __proto__ as an ordinary key, never a prototype write', () => {
    const map = parseCookies('__proto__=x; constructor=y');
    expect(map['__proto__']).toBe('x');
    expect(map['constructor']).toBe('y');
    expect(({} as any).x).toBeUndefined();
  });
});

describe('setCookie', () => {
  it('T4: documented defaults, Secure per D10', () => {
    expect(setCookie('s', 'v')).toBe('s=v; Path=/; Secure; HttpOnly; SameSite=Lax');
  });

  it('serialises every option', () => {
    const expires = new Date(Date.UTC(2030, 0, 1));
    expect(
      setCookie('s', 'v', {
        maxAge: 10,
        expires,
        domain: 'example.com',
        path: '/app',
        httpOnly: false,
        sameSite: 'none',
        partitioned: true,
      }),
    ).toBe(
      's=v; Max-Age=10; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Domain=example.com; Path=/app; Secure; SameSite=None; Partitioned',
    );
    expect(setCookie('s', 'v', { secure: false, sameSite: 'strict' })).toBe('s=v; Path=/; HttpOnly; SameSite=Strict');
  });

  it('T5: refuses header injection and bad names, naming the field', () => {
    expect(() => setCookie('s', 'v\r\nX: y')).toThrow(/value for 's'/);
    expect(() => setCookie('a b', 'v')).toThrow(/name "a b"/);
    for (const bad of ['a;b', 'a,b', 'a b', 'a\tb', 'a\u0001b'])
      expect(() => setCookie('s', bad), JSON.stringify(bad)).toThrow(/value/);
    expect(() => setCookie('s', 'v', { path: '/\r\nX: y' })).toThrow(/path/);
    expect(() => setCookie('s', 'v', { domain: 'a.com\nX' })).toThrow(/domain/);
    expect(() => setCookie('s', 'v', { path: '/; Domain=evil' })).toThrow(/path/);
    expect(() => setCookie('s', 'v', { maxAge: 1.5 })).toThrow(/maxAge/);
    expect(() => setCookie('s', 'v', { expires: new Date('nope') })).toThrow(/expires/);
    expect(() => setCookie('s', 'v', { sameSite: 'loose' as never })).toThrow(/sameSite/);
  });

  it('T6: sameSite none and partitioned both require secure', () => {
    expect(() => setCookie('s', 'v', { sameSite: 'none', secure: false })).toThrow(/sameSite 'none'.*secure/);
    expect(() => setCookie('s', 'v', { partitioned: true, secure: false })).toThrow(/partitioned.*secure/);
  });
});

describe('@cookie / @cookies on a live Node server', () => {
  it('T1: first wins and decodes', async () => {
    const res = await raw('/c/one', { cookie: 'a=1; a=2; b=%41' });
    expect(JSON.parse(res.body)).toEqual({ a: '1', b: 'A' });
  });

  it('T2: malformed pairs never 400', async () => {
    const res = await raw('/c/all', { cookie: '=x; c; d=%ZZ; e=5' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).all).toEqual({ d: '%ZZ', e: '5' });
  });

  it('T3: no Cookie header', async () => {
    expect(JSON.parse((await raw('/c/all')).body).all).toEqual({});
    expect(JSON.parse((await raw('/c/one')).body)).toEqual({ a: null, b: null });
  });

  it('picks a key list', async () => {
    expect(JSON.parse((await raw('/c/pick', { cookie: 'd=4; e=5; f=6' })).body)).toEqual({ d: '4', e: '5' });
  });

  it('@needs("cookies") resolves the same map', async () => {
    expect(JSON.parse((await raw('/c/needs', { cookie: 'sid=abc' })).body)).toEqual({ sid: 'abc' });
  });

  it('resolves on a WebSocket route', async () => {
    await boot();
    const client = new WebSocket(`ws://127.0.0.1:${port}/c/ws`, { headers: { cookie: 'a=hello' } });
    const message = await new Promise<string>((resolve, reject) => {
      client.on('message', (data) => resolve(String(data)));
      client.on('error', reject);
    });
    client.close();
    expect(message).toBe('a=hello');
  });
});

describe('several Set-Cookie lines', () => {
  it('T7: custom @Transformer, Node: two lines', async () => {
    const res = await raw('/c/transformer');
    expect(valuesOf(res.lines, 'set-cookie')).toEqual([C1, C2]);
  });

  it('T7: custom @Transformer, app.fetch: two lines', async () => {
    const res = await fetchVia('/c/transformer');
    expect(res.headers.getSetCookie()).toEqual([C1, C2]);
  });

  it('T8: HttpError.headers and an onError renderer: two lines on both adapters', async () => {
    for (const path of ['/c/error', '/c/renderer']) {
      const res = await raw(path);
      expect(valuesOf(res.lines, 'set-cookie'), path).toEqual([C1, C2]);
      expect((await fetchVia(path)).headers.getSetCookie(), path).toEqual([C1, C2]);
    }
  });

  it('T9: array kept, injected vary merged with a handler vary array', async () => {
    const res = await raw('/c/custom', { origin: 'http://ok.test' });
    const vary = valuesOf(res.lines, 'vary');
    expect(vary).toHaveLength(1);
    expect(vary[0].split(', ')).toEqual(['Accept', 'Accept-Language', 'Origin']);
    const viaFetch = await fetchVia('/c/custom', { origin: 'http://ok.test' });
    expect(viaFetch.headers.get('vary')).toBe('Accept, Accept-Language, Origin');

    const cookieRes = await raw('/c/transformer', { origin: 'http://ok.test' });
    expect(valuesOf(cookieRes.lines, 'set-cookie')).toEqual([C1, C2]);
    expect(valuesOf(cookieRes.lines, 'vary')).toEqual(['Origin']);
  });

  it('T11: any other array header is one line joined with ", "', async () => {
    const res = await raw('/c/custom');
    expect(valuesOf(res.lines, 'x-custom')).toEqual(['a, b']);
    expect((await fetchVia('/c/custom')).headers.get('x-custom')).toBe('a, b');
  });

  it('injected security headers stay authoritative over a handler array', async () => {
    @Route('/s')
    class Spoof {
      @Get('/')
      @Transformer(() => ({ headers: { 'x-content-type-options': ['sniff', 'me'] }, body: '' }))
      get() {
        return null;
      }
    }
    @Module({ mountpoint: '/', controllers: [Spoof] })
    class SM {}

    const res = await createApp({ modules: [SM] }).fetch(new Request('http://x/s'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('OpenAPI', () => {
  it('lists a @cookie arg as an in: cookie parameter', () => {
    const doc = app.openapi();
    const params = (doc.paths['/c/one'].get as any).parameters;
    expect(params).toEqual(
      expect.arrayContaining([
        { name: 'a', in: 'cookie', required: false, schema: { type: 'string' } },
        { name: 'b', in: 'cookie', required: false, schema: { type: 'string' } },
      ]),
    );
  });
});

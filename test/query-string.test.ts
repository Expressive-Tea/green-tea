import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Get, Module, Route, Transformer } from '../src/metadata';
import { JsonTransformer } from '../src/transformers';
import { createApp } from '../src/app';
import { parseQuery } from '../src/http';
import { query } from '../src/params';

// CARD-25 / GitHub #48: the query string is everything after the FIRST `?` (and before `#`).
const CASES: Array<[string, Record<string, string>]> = [
  ['/search?q=what?now', { q: 'what?now' }], // T1
  ['/search?a=1&b=?', { a: '1', b: '?' }], // T2
  ['/search?', {}], // T3
  ['/search', {}], // T4
];

describe('parseQuery', () => {
  test.each(CASES)('%s', (url, expected) => {
    expect(parseQuery(url)).toEqual(expected);
  });

  test('stops at a fragment', () => {
    expect(parseQuery('/search?q=a?b#frag?x=1')).toEqual({ q: 'a?b' });
  });
});

@Route('/search')
class SearchCtl {
  @Get('/')
  @Transformer(JsonTransformer)
  search(@query() q: Record<string, string>) {
    return q;
  }
}

@Module({ mountpoint: '/', controllers: [SearchCtl] })
class SearchModule {}

describe('query string with more than one `?`', () => {
  const app = createApp({ modules: [SearchModule] });
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = await app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test.each(CASES)('app.fetch %s', async (url, expected) => {
    const res = await app.fetch(new Request(`http://x${url}`));
    expect(await res.json()).toEqual(expected);
  });

  test.each(CASES)('Node listener %s', async (url, expected) => {
    const res = await fetch(`${base}${url}`);
    expect(await res.json()).toEqual(expected);
  });
});

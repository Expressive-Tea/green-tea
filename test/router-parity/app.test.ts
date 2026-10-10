/**
 * Application-level router parity: what a client sees through `app.fetch` and through a real Node
 * socket — status, `Allow`, response headers, and HEAD body suppression. Matcher equality alone
 * cannot prove these: the 404/405/OPTIONS decisions, the 400 for a bad path and the HEAD body rule
 * live in `src/http/core.ts`, around the matcher.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/index';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ParityHttpModule,
  REQUESTS,
  runAppDifferential,
  stableHeaders,
  viaFetch,
  type Observed,
  type Req,
} from './app-fixture';
import type { App } from '../../src/app/types';
import { frozen, expectFrozenEqual } from './frozen';

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

  it('the runtime-neutral app differential (the one Deno, Bun and workerd run) reports no mismatch', async () => {
    const dir = join(__dirname, 'frozen');
    const report = await runAppDifferential((name) => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')));
    expect(report.mismatches).toEqual([]);
  });
});

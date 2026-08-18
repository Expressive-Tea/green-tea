import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { connectLink, missingFromManifest } from '../../src/mesh/link';
import { encode, decode, MESH_PROTOCOL_VERSION, type Manifest } from '../../src/mesh/protocol';

const V = MESH_PROTOCOL_VERSION;
const env = { method: 'GET', params: {}, query: {}, body: undefined, headers: {} };

/**
 * A teapot bound to a fixed port so it can be killed and restarted at the same URL — which is the
 * whole point here: reconnection means returning to the *same* teapot, not finding another one.
 * Its manifest is swappable so a restart can come back exporting something different.
 */
function teapotOn(port: number, manifest: Manifest, answer: unknown = { ok: true }) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    let authed = false;
    ws.on('message', (d) => {
      const frame = decode(d.toString());
      if (!authed) {
        if (frame.type === 'hello' && frame.secret === 'good') {
          authed = true;
          ws.send(encode({ type: 'manifest', v: V, scopes: manifest.scopes, routes: manifest.routes }));
        } else ws.close(1008);
        return;
      }
      if (frame.type === 'ping') ws.send(encode({ type: 'pong' }));
      if (frame.type === 'rpc-req') ws.send(encode({ type: 'rpc-res', id: frame.id, ok: true, result: answer }));
    });
  });

  return new Promise<{ close: () => Promise<void> }>((resolve) => {
    wss.on('listening', () =>
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      }),
    );
  });
}

/** A free port, taken by opening and immediately closing a server on port 0. */
async function freePort(): Promise<number> {
  const probe = new WebSocketServer({ port: 0 });
  await new Promise((r) => probe.on('listening', r));
  const port = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));

  return port;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const url = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;
const SCOPES: Manifest = { scopes: [{ token: 'auth', scope: 'app' }], routes: [] };
const fast = { initialDelayMs: 20, maxDelayMs: 60 };

describe('mesh reconnection', () => {
  it('reconnects to the same teapot and serves again', async () => {
    const port = await freePort();
    let teapot = await teapotOn(port, SCOPES);
    const link = await connectLink({ url: url(port), secret: 'good', reconnect: fast, heartbeatMs: 50 });

    expect(await link.rpc('scope', 'auth', env)).toEqual({ ok: true });

    await teapot.close();
    await settle(50);
    // the window where the link is down answers immediately rather than after timeoutMs
    await expect(link.rpc('scope', 'auth', env)).rejects.toMatchObject({ status: 503 });

    teapot = await teapotOn(port, SCOPES, { ok: 'again' });
    await settle(300);

    expect(await link.rpc('scope', 'auth', env)).toEqual({ ok: 'again' });
    link.close();
    await teapot.close();
  });

  it('refuses a returning teapot whose manifest lost a token the graph needs', async () => {
    const port = await freePort();
    let teapot = await teapotOn(port, SCOPES);
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const link = await connectLink({ url: url(port), secret: 'good', reconnect: fast, heartbeatMs: 50, logger });

    await teapot.close();
    await settle(50);

    // comes back exporting nothing — the graph was validated against 'auth' at boot
    teapot = await teapotOn(port, { scopes: [], routes: [] });
    await settle(300);

    await expect(link.rpc('scope', 'auth', env)).rejects.toMatchObject({ status: 503 });
    expect(warnings.some((w) => w.includes("app-scope 'auth'") && w.includes('refusing to reconnect'))).toBe(true);
    // logged once per distinct manifest, not once per attempt
    expect(warnings.filter((w) => w.includes('refusing to reconnect')).length).toBe(1);

    link.close();
    await teapot.close();
  });

  it('stops reconnecting once the application closes the link', async () => {
    const port = await freePort();
    const teapot = await teapotOn(port, SCOPES);
    const link = await connectLink({ url: url(port), secret: 'good', reconnect: fast, heartbeatMs: 50 });

    await teapot.close();
    link.close();

    // if close() were not terminal, the link would reconnect to the teapot that comes back here —
    // which is what would leave app.close() with a process that cannot exit
    const revived = await teapotOn(port, SCOPES, { ok: 'revived' });
    await settle(300);

    await expect(link.rpc('scope', 'auth', env)).rejects.toMatchObject({ status: 503 });
    await revived.close();
  });

  it('reconnect: false keeps the old fail-once behaviour', async () => {
    const port = await freePort();
    let teapot = await teapotOn(port, SCOPES);
    const link = await connectLink({ url: url(port), secret: 'good', reconnect: false, heartbeatMs: 50 });

    await teapot.close();
    teapot = await teapotOn(port, SCOPES);
    await settle(300);

    await expect(link.rpc('scope', 'auth', env)).rejects.toMatchObject({ status: 503 });
    link.close();
    await teapot.close();
  });
});

describe('missingFromManifest', () => {
  const booted: Manifest = {
    scopes: [
      { token: 'auth', scope: 'request' },
      { token: 'config', scope: 'app' },
    ],
    routes: [{ method: 'GET', pattern: '/svc/:id' }],
  };

  it('accepts an identical manifest', () => {
    expect(missingFromManifest(booted, booted)).toEqual([]);
  });

  it('accepts extra exports — the graph is fixed at boot and nothing new is spliced', () => {
    const wider: Manifest = {
      scopes: [...booted.scopes, { token: 'billing', scope: 'app' }],
      routes: [...booted.routes, { method: 'POST', pattern: '/svc/new' }],
    };
    expect(missingFromManifest(booted, wider)).toEqual([]);
  });

  it('accepts a route parameter that was only renamed', () => {
    const renamed: Manifest = { scopes: booted.scopes, routes: [{ method: 'GET', pattern: '/svc/:name' }] };
    expect(missingFromManifest(booted, renamed)).toEqual([]);
  });

  it('reports a token whose lifetime changed, since the graph resolved it under the old one', () => {
    const flipped: Manifest = {
      scopes: [
        { token: 'auth', scope: 'app' },
        { token: 'config', scope: 'app' },
      ],
      routes: booted.routes,
    };
    expect(missingFromManifest(booted, flipped)).toEqual(["request-scope 'auth'"]);
  });

  it('reports a missing route by method and pattern', () => {
    const routeless: Manifest = { scopes: booted.scopes, routes: [] };
    expect(missingFromManifest(booted, routeless)).toEqual(["route 'GET /svc/:id'"]);
  });
});

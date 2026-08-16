// Real Deno integration test for the bounded close() serveDeno returns. app.close() cannot do this
// job on Deno — it returns at its `if (!server)` guard, because a Deno app is served through
// app.fetch and never through listen() — so the deadline lives on the transport that owns the
// handle. See issue #15.
//
// Run with: npm run test:deno
import 'reflect-metadata';
import { createApp, Route, Get, Module } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Route('/')
class Ctl {
  @Get('/hang')
  hang() {
    return new Promise(() => {}); // never resolves — a stuck handler
  }
  @Get('/slow')
  async slow() {
    await new Promise((r) => setTimeout(r, 200)); // finite, so draining has something real to wait out
    return { ok: true };
  }
}
@Module({ mountpoint: '/', controllers: [Ctl] })
class M {}

const portOf = (server: { addr?: { port: number } }): number => server.addr!.port;

// On Deno the deadline bounds the wait, not the connections — see the comment on serveDeno's
// force callback. This test asserts exactly that: close() returns on time, and does so without
// the uncaught BadResource that aborting a draining server produces. The test runner fails on
// that error even when the assertions pass, so a green run here is the real assertion.
Deno.test('serveDeno close({ timeoutMs }) returns on a stuck handler without forcing', async () => {
  const server = serveDeno(createApp({ modules: [M] }), { port: 0, onListen: () => {} });

  fetch(`http://127.0.0.1:${portOf(server)}/hang`).catch(() => {});
  await new Promise((r) => setTimeout(r, 50)); // let the request actually reach the handler

  const start = Date.now();
  await server.close({ timeoutMs: 300 });
  const elapsed = Date.now() - start;

  // The assertion that matters is the upper bound: without the deadline this never returns.
  if (elapsed >= 2000) throw new Error(`close() took ${elapsed}ms — the deadline did not fire`);
  if (elapsed < 250) throw new Error(`close() returned in ${elapsed}ms — it did not wait the deadline`);
});

Deno.test('serveDeno close() drains an in-flight request rather than cutting it', async () => {
  const server = serveDeno(createApp({ modules: [M] }), { port: 0, onListen: () => {} });

  const inFlight = fetch(`http://127.0.0.1:${portOf(server)}/slow`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 50)); // must be *in* the handler before we close

  await server.close({ timeoutMs: 5000 });

  const body = await inFlight;
  if (body.ok !== true) throw new Error(`in-flight request was cut: ${JSON.stringify(body)}`);
});

Deno.test('a caller-supplied signal still aborts the server', async () => {
  const ac = new AbortController();
  const server = serveDeno(createApp({ modules: [M] }), { port: 0, signal: ac.signal, onListen: () => {} });

  ac.abort();
  await server.finished; // hangs here if chaining the caller's signal into ours dropped it
});

// Not a test — a Deno app with `handleSignals: true`, spawned by test/deno/signals.test.ts.
// Deno's test runner only discovers *.test.ts, so this file is ignored by `deno test`.
//
// It exists because Deno is where the signal API actually differs: `Deno.addSignalListener` and
// `Deno.exit` rather than `process.on`/`process.exit`, and a listener that holds the process open
// until it is removed. Node passing says nothing about any of that.
import 'npm:reflect-metadata';
import { createApp, Module } from '../../src/index.ts';
import { serveDeno } from '../../src/deno.ts';

@Module({ mountpoint: '/', controllers: [] })
class Mod {}

// A hook rather than a provider's `dispose()`: on Deno nothing boots until the first request, so an
// unvisited app has no provider to dispose and the run would pass without proving anything. The
// hook registers at `createApp`, which makes "teardown ran" mean "close() was reached".
const app = createApp({
  modules: [Mod],
  handleSignals: true,
  hooks: [{ onShutdown: () => console.log(JSON.stringify({ disposed: true })) }],
});

// `ready` is printed after `serveDeno` returns, not from `onListen` — Deno calls `onListen`
// synchronously from inside `Deno.serve`, so a parent that signals on that line races the handler
// registration that happens a few statements later and wins.
const server = serveDeno(app, { port: 0, onListen: () => {} });

console.log(JSON.stringify({ ready: true }));
void server;

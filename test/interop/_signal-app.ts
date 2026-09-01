// Not a test — a Node app with `handleSignals: true`, spawned by shutdown-signals.test.ts.
//
// Signal handling can only be told apart from doing nothing by a real process that really gets a
// real signal: an in-process test would have to fire the handler by hand, and the handler's whole
// job is to exit the process it is running in.
//
// Prints one JSON line per event on stdout: {"ready":port}, then {"disposed":n} per dispose call.
import 'reflect-metadata';
import { createApp, Provider, Route, Get, Module } from '../../src/index';

const SLOW = Number(process.env.DISPOSE_DELAY_MS ?? 0);
let disposals = 0;

@Provider({ provides: 'db' })
class Db {
  provide() {
    return { db: { name: 'db' } };
  }

  async dispose() {
    if (SLOW) await new Promise((r) => setTimeout(r, SLOW));
    disposals++;
    console.log(JSON.stringify({ disposed: disposals }));
  }
}

@Route('/')
class Api {
  @Get('/ping') ping() {
    return { ok: true };
  }
}

@Module({ mountpoint: '/', controllers: [Api], providers: [Db] })
class Mod {}

const app = createApp({ modules: [Mod], handleSignals: process.env.HANDLE_SIGNALS !== 'false' });

void app.listen(0).then((server) => {
  console.log(JSON.stringify({ ready: (server.address() as { port: number }).port }));
});

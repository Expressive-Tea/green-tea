// Worker entry for the real workerd (Miniflare) integration test.
// Mirrors test/deno/ws.test.ts's graph so HTTP + WebSocket behavior is proven
// identically across runtimes. Run via `npm run test:edge` (see test/edge/run.ts).
import { createApp, Route, Get, Ws, ctx, Module } from '../../src/index';
import { edgeHandler } from '../../src/edge';

@Route('/rt')
class Rt {
  @Get('/hello')
  hello() {
    return { ok: true };
  }

  @Ws('/echo')
  echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${msg}`;
    })();
  }
}

@Module({ mountpoint: '/', controllers: [Rt] })
class M {}

const app = createApp({ modules: [M] });

export default { fetch: edgeHandler(app) };

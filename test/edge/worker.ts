// Worker entry for the real workerd (Miniflare) integration test.
// Mirrors test/deno/ws.test.ts's graph so HTTP + WebSocket behavior is proven
// identically across runtimes. Run via `npm run test:edge` (see test/edge/run.ts).
import { createApp, Route, Get, Post, Ws, body, ctx, Module } from '../../src/index';
import { edgeHandler } from '../../src/edge';

@Route('/rt')
class Rt {
  @Get('/hello')
  hello() {
    return { ok: true };
  }

  // #105: the body limit, read from workerd's own request stream. Small, so every refused body still
  // fits in the socket buffer: a client that is mid-upload when the 413 lands can see ECONNRESET
  // instead, which is the transport racing the answer rather than a different answer.
  @Post('/body', { maxBodyBytes: 1000 })
  body(@body() b: unknown) {
    return { length: String(b).length };
  }

  @Ws('/echo')
  echo(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `echo:${msg}`;
    })();
  }

  // Never reads `inbound`, so every frame the client sends stays queued (#107).
  @Ws('/stall')
  stall() {
    return (async function* () {
      await new Promise<never>(() => {});
      yield '';
    })();
  }

  @Ws('/room/:name')
  room(@ctx() { inbound }: any) {
    return (async function* () {
      for await (const msg of inbound) yield `room:${msg}`;
    })();
  }
}

@Module({ mountpoint: '/', controllers: [Rt] })
class M {}

const app = createApp({ modules: [M] });
// #107: the same graph with tight ws limits, reached through the `limited` host.
const limited = createApp({ modules: [M], limits: { maxWsMessageBytes: 1024, maxWsQueue: 4 } });
const handlers = { default: edgeHandler(app), limited: edgeHandler(limited) };

export default {
  fetch: (request: Request, env?: unknown, ctx?: Parameters<typeof handlers.default>[2]) =>
    (new URL(request.url).hostname === 'limited' ? handlers.limited : handlers.default)(request, env, ctx),
};

// Worker entry for the real workerd (Miniflare) integration test.
// Mirrors test/deno/ws.test.ts's graph so HTTP + WebSocket behavior is proven
// identically across runtimes. Run via `npm run test:edge` (see test/edge/run.ts).
import { createApp, Route, Get, Post, Ws, body, ctx, cookie, Module, Transformer, HttpError } from '../../src/index';
import { edgeHandler } from '../../src/edge';

@Route('/rt')
class Rt {
  @Get('/hello')
  hello() {
    return { ok: true };
  }

  // CARD-14 (#113): two Set-Cookie lines from workerd, and @cookie on the request side.
  @Get('/cookies')
  @Transformer(() => ({ headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], 'x-custom': ['a', 'b'] }, body: '{}' }))
  cookies() {
    return null;
  }

  @Get('/cookie-error')
  cookieError() {
    throw new HttpError(401, 'nope', undefined, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
  }

  @Get('/cookie')
  readCookie(@cookie('b') b: string | undefined) {
    return { b: b ?? null };
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

  // CARD-23: what `ctx.ip` resolved to, over HTTP and over a WebSocket upgrade.
  @Get('/ip')
  ip(@ctx() c: any) {
    return { ip: c.ip };
  }

  @Ws('/ws-ip')
  wsIp(@ctx() c: any) {
    return (async function* () {
      yield `ip:${c.ip}`;
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
// CARD-23: the same graph under `trustProxy`, reached through the `trusted` host.
const trusted = createApp({ modules: [M], trustProxy: true });
const handlers: Record<string, ReturnType<typeof edgeHandler>> = {
  default: edgeHandler(app),
  limited: edgeHandler(limited),
  trusted: edgeHandler(trusted),
  // CARD-17 T10: health probes, reached through the `health` host. Never booted by anything but probes.
  health: edgeHandler(createApp({ modules: [M], health: true })),
};

// CARD-21 (D17): a route on the reserved mesh path must fail createApp inside workerd too. Built per
// request on the `reserved` host so a regression answers with a status instead of breaking the worker.
@Route('/')
class Claims {
  @Ws('/__mesh__/control')
  control() {
    return (async function* () {})();
  }
}
@Module({ mountpoint: '/', controllers: [Claims] })
class ClaimsModule {}

function reservedBoot(): Response {
  try {
    createApp({ modules: [ClaimsModule] });
  } catch (error) {
    return new Response((error as Error).message, { status: 500 });
  }
  return new Response('booted', { status: 200 });
}

export default {
  fetch: (request: Request, env?: unknown, ctx?: Parameters<ReturnType<typeof edgeHandler>>[2]) => {
    const host = new URL(request.url).hostname;
    if (host === 'reserved') return reservedBoot();
    return (handlers[host] ?? handlers.default)(request, env, ctx);
  },
};

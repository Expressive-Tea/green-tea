import 'reflect-metadata';
import { createApp, Route, Get, Sse, Ws, Module, inbound, channel } from '../../dist/index.mjs';

// The app `scripts/soak.ts` drives (#80): buffered JSON, SSE, WebSocket echo and a busy fan-out
// channel that a slow subscriber never reads. Built `dist/`, like the runtimes bench.
const gc = (globalThis as { gc?: () => void }).gc;
let unhandled = 0;
process.on('unhandledRejection', (e) => {
  unhandled++;
  console.error('unhandledRejection', e);
});

const hub = channel<{ t: number }>();
setInterval(() => hub.push({ t: Date.now() }), 1).unref();

@Route('/')
class Soak {
  @Get('/json') json() {
    return { hello: 'world', at: Date.now() };
  }
  @Sse('/ticks') ticks() {
    return (async function* () {
      for (let i = 0; ; i++) {
        yield { i };
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
  }
  @Sse('/hub') hub() {
    return hub;
  }
  @Ws('/echo') echo(@inbound() inc: AsyncIterable<string>) {
    const out = channel<string>();
    (async () => {
      for await (const m of inc) out.push(m);
      out.close();
    })();
    return out;
  }
  @Get('/__mem') mem() {
    gc?.();
    const m = process.memoryUsage();
    const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles().length;
    return { rss: m.rss, heapUsed: m.heapUsed, handles, unhandled };
  }
}

@Module({ mountpoint: '/', controllers: [Soak] })
class SoakModule {}

const app = createApp({ modules: [SoakModule], security: false, handleSignals: true });
const server = await app.listen(0);
console.log(`READY ${(server.address() as { port: number }).port}`);

// #85: one remote step call ran every step on the teapot. It now runs the exported step's own
// closure, the way a route runs only the steps it needs.
import { describe, it, expect } from 'vitest';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index';

let unrelatedRuns = 0;
let baseRuns = 0;

@Step({ provides: 'base', needs: [] })
class Base {
  run() {
    baseRuns++;
    return { base: 'b' };
  }
}
@Step({ provides: 'billing', needs: ['base'], export: true })
class Billing {
  run(ctx: { base: string }) {
    return { billing: `bill:${ctx.base}` };
  }
}
@Step({ provides: 'unrelated', needs: [] })
class Unrelated {
  run() {
    unrelatedRuns++;
    return { unrelated: 1 };
  }
}
@Step({ provides: 'broken', needs: [] })
class Broken {
  run(): never {
    throw new Error('unrelated step failed');
  }
}
@Module({ mountpoint: '/api', steps: [Base, Billing, Unrelated, Broken] })
class TeapotModule {}

@Route('/local')
class Ctl {
  @Get('/bill')
  bill(@needs('billing') billing: string) {
    return { billing };
  }
}
@Module({ mountpoint: '/api', controllers: [Ctl] })
class TeacupModule {}

describe('a remote step call', () => {
  it('runs the exported step and its ancestors only', async () => {
    const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: 'x' } });
    const server = await teapot.listen(0);
    const port = (server.address() as { port: number }).port;
    const teacup = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: `ws://127.0.0.1:${port}/__mesh__/control`, secret: 'x' }] },
    });

    try {
      for (let i = 0; i < 3; i++) {
        const res = await teacup.fetch(new Request('http://x/api/local/bill'));
        // an unrelated step that throws no longer breaks the export
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ billing: 'bill:b' });
      }
      expect(baseRuns).toBe(3); // an ancestor still runs, once per call
      expect(unrelatedRuns).toBe(0); // a step nobody asked for does not
    } finally {
      await teacup.close();
      await teapot.close();
      server.close();
    }
  });
});

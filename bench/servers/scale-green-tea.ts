import 'reflect-metadata';
import { createApp, Step, Route, Get, Module, needs } from '../../src/index';

// 100 chained steps: s1..s100, each needs the previous. A route that @needs the Nth
// pulls exactly N steps transitively — so /chain/100 runs the full 100-deep graph slice.
function makeStep(n: number) {
  @Step({ provides: `s${n}`, needs: n > 1 ? [`s${n - 1}`] : [] })
  class S { run() { return { [`s${n}`]: n }; } }
  return S;
}
const steps = Array.from({ length: 100 }, (_, i) => makeStep(i + 1));

@Route('/chain')
class Chain {
  @Get('/0') d0() { return { ok: 1 }; }
  @Get('/10') d10(@needs('s10') s: number) { return { s }; }
  @Get('/25') d25(@needs('s25') s: number) { return { s }; }
  @Get('/50') d50(@needs('s50') s: number) { return { s }; }
  @Get('/75') d75(@needs('s75') s: number) { return { s }; }
  @Get('/100') d100(@needs('s100') s: number) { return { s }; }
}

@Module({ mountpoint: '/', steps, controllers: [Chain] })
class ScaleModule {}

const app = createApp({ modules: [ScaleModule], security: false });

async function main() {
  const server = await app.listen(0);
  server.keepAliveTimeout = 5000;
  console.log(`READY ${(server.address() as any).port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

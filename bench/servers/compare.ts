// A/B bench server. Identical file dropped into both trees, so each side compiles against its own
// `src/`. Adds the two paths the standard bench server does not exercise and this release changed:
// secure-by-default headers, and a `cors.origins` predicate.
import 'reflect-metadata';
import { createApp, Step, Route, Get, Post, Module, needs, param, body } from '../../src/index';

type Ctor = new (...args: any[]) => any;

const emailSchema = {
  '~standard': { version: 1 as const, vendor: 'bench', validate: (v: any) =>
    (v && typeof v.email === 'string' && v.email.includes('@')) ? { value: v } : { issues: [{ message: 'invalid email' }] } },
};

function makeStep(n: number) {
  @Step({ provides: `s${n}`, needs: n > 1 ? [`s${n - 1}`] : [] })
  class S { run() { return { [`s${n}`]: n }; } }
  return S;
}
const steps = [1, 2, 3, 4, 5].map(makeStep);

@Route('/')
class Bench {
  @Get('/hello') hello() { return { hello: 'world' }; }
  @Get('/users/:id') user(@param('id') id: string) { return { id }; }
  @Get('/pipeline') pipeline(@needs('s3') s3: number) { return { hello: 'world', s3 }; }
  @Post('/validate') validate(@body(emailSchema) b: any) { return { email: b.email }; }
  @Get('/steps/5') steps5(@needs('s5') s5: number) { return { hello: 'world', s5 }; }
  // Reads the counter without resetting it — the read itself carries no Origin, so it cannot
  // change what it reports.
  @Get('/cors-calls') corsCalls() { return { calls: corsCalls }; }
}

// Filler routes, so the width of the route table becomes a dimension the harness can see.
//
// Every matcher cost discussed for this file — the specificity scan, the per-candidate
// `decodeURIComponent`, the per-request `compilePattern` lookups — scales with how many candidate
// routes a request has to walk past. At the six routes the cross-framework table uses, all of them
// measure as noise, which says nothing about them and everything about the instrument. `/users/:id`
// is declared last so a request for it pays the full scan.
function fillerRoutes(count: number): Ctor[] {
  return Array.from({ length: count }, (_, i) => {
    @Route(`/filler${i}`)
    class Filler {
      @Get('/:a/:b') ab(@param('a') a: string) {
        return { a };
      }
    }
    return Filler as Ctor;
  });
}

const EXTRA = Number(process.env.GT_ROUTES ?? 0);

@Module({ mountpoint: '/', steps, controllers: [...fillerRoutes(EXTRA), Bench] })
class BenchModule {}

// A predicate rather than a list: that is the shape `cors.origins` takes a function for, and the
// one this release stopped evaluating two and three times per request.
const ALLOWED = new Set(['http://bench.example']);
let corsCalls = 0;
const cors =
  process.env.GT_CORS === '1'
    ? {
        origins: (o: string) => {
          corsCalls++;
          return ALLOWED.has(o);
        },
      }
    : undefined;

const app = createApp({
  modules: [BenchModule],
  security: process.env.GT_SECURE === '1',
  ...(cors ? { cors } : {}),
});

async function main() {
  try { if (app.inspect('/hello').length === 0) throw new Error('empty'); }
  catch { console.error('DECORATORS_NOT_APPLIED'); process.exit(1); }
  const server = await app.listen(0);
  server.keepAliveTimeout = 5000;
  console.log(`READY ${(server.address() as any).port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

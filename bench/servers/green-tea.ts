import 'reflect-metadata';
import { createApp, Step, Route, Get, Post, Module, needs, param, body } from '../../src/index';

// email schema (Standard Schema, hand-rolled — same field check the others do)
const emailSchema = {
  '~standard': { version: 1 as const, vendor: 'bench', validate: (v: any) =>
    (v && typeof v.email === 'string' && v.email.includes('@')) ? { value: v } : { issues: [{ message: 'invalid email' }] } },
};

// 5 chained steps: s1..s5, each needs the previous. Routes @needs the Nth to pull exactly N.
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
  @Get('/steps/0') steps0() { return { hello: 'world' }; }
  @Get('/steps/3') steps3(@needs('s3') s3: number) { return { hello: 'world', s3 }; }
  @Get('/steps/5') steps5(@needs('s5') s5: number) { return { hello: 'world', s5 }; }
}

@Module({ mountpoint: '/', steps, controllers: [Bench] })
class BenchModule {}

// PARITY: security OFF for the cross-framework table. GT_SECURE=1 flips it on for the secure-cost micro-bench.
const secure = process.env.GT_SECURE === '1';
const app = createApp({ modules: [BenchModule], security: secure });

async function main() {
  // fail loudly if decorators didn't apply (inspect throws "no route" on empty plan, so wrap)
  try { if (app.inspect('/hello').length === 0) throw new Error('empty'); }
  catch { console.error('DECORATORS_NOT_APPLIED'); process.exit(1); }
  const server = await app.listen(0);
  server.keepAliveTimeout = 5000; // parity value (all servers use 5000)
  console.log(`READY ${(server.address() as any).port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

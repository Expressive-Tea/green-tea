import 'reflect-metadata';
import { createApp, Step, Route, Get, Post, Module, needs, param, body } from '../../dist/index.mjs';
import { serveBun } from '../../dist/bun.mjs';

// Same BenchModule as green-tea.ts (Node), served via Bun.serve instead of app.listen.
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
  @Get('/steps/0') steps0() { return { hello: 'world' }; }
  @Get('/steps/3') steps3(@needs('s3') s3: number) { return { hello: 'world', s3 }; }
  @Get('/steps/5') steps5(@needs('s5') s5: number) { return { hello: 'world', s5 }; }
}

@Module({ mountpoint: '/', steps, controllers: [Bench] })
class BenchModule {}

const app = createApp({ modules: [BenchModule], security: false });
const server = serveBun(app, { port: 0, hostname: '0.0.0.0' });
console.log(`READY ${server.port}`);

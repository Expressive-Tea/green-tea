// Not a test — a Node-hosted mesh peer, spawned by mesh-interop.test.ts. Deno's test runner
// only discovers *.test.ts, so this file is ignored by `deno test`.
//
// It exists so the interop claim is tested rather than reasoned about: Deno<->Deno passing
// says nothing about a Node teapot serving a Deno teacup, which is the actual deployment
// shape once mesh spans runtimes. Node's side uses the `ws` package (WebSocketServer +
// nodeSocket); Deno's uses its global WebSocket. Only a real cross-process run exercises both.
//
// Modes:
//   teapot            -> exports scopes, prints {"port":N}, serves until killed
//   teacup <controlUrl> -> consumes the remote scopes, prints {"ok":true,"body":{...}}
import 'reflect-metadata';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index';

const SECRET = process.env.MESH_SECRET ?? 's3cr3t';

@Provider({ provides: 'config', export: true })
class Config {
  provide() {
    return { config: { region: 'mx', runtime: 'node' } };
  }
}
@Step({ provides: 'auth', needs: [], export: true })
class Auth {
  run(ctx: any) {
    return { auth: { token: ctx.headers?.['x-token'] ?? 'anon' } };
  }
}
@Module({ mountpoint: '/api', providers: [Config], steps: [Auth] })
class TeapotModule {}

@Route('/local')
class LocalCtl {
  @Get('/who')
  who(@needs('config') config: any, @needs('auth') auth: any) {
    return { config, auth };
  }
}
@Module({ mountpoint: '/api', controllers: [LocalCtl] })
class TeacupModule {}

const [mode, controlUrl] = process.argv.slice(2);

async function main(): Promise<void> {
  if (mode === 'teapot') {
    const app = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
    const server = await app.listen(0);
    console.log(JSON.stringify({ port: (server.address() as { port: number }).port }));
    return; // stays alive on the open server until the parent kills it
  }

  if (mode === 'teacup') {
    const app = createApp({
      modules: [TeacupModule],
      experimental: true,
      mesh: { teapots: [{ url: controlUrl, secret: SECRET }], timeoutMs: 5000 },
    });
    const res = await app.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'abc' } }));
    const body = await res.json();
    console.log(JSON.stringify({ ok: res.status === 200, body }));
    await app.close();
    process.exit(0);
  }

  throw new Error(`unknown mode: ${mode}`);
}

main().catch((err: unknown) => {
  console.log(JSON.stringify({ ok: false, error: String((err as Error).message) }));
  process.exit(1);
});

// Cross-runtime mesh: a Node peer and a Deno peer, in separate processes, talking over the
// wire protocol. This is the test the whole cross-runtime effort exists for.
//
// Deno<->Deno and Node<->Node passing prove each runtime works with itself; neither proves a
// Node teapot can serve a Deno teacup, which is the shape mesh actually deploys in once it
// spans runtimes. The two sides use genuinely different code here — Node serves through the
// `ws` package (WebSocketServer + nodeSocket) and connects with it too; Deno uses its global
// WebSocket both ways — so only a real cross-process run exercises the pairing.
//
// Run with: npm run test:deno   (needs --allow-run to spawn the Node peer)
import 'npm:reflect-metadata';
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { createApp, Provider, Step, Route, Get, Module, needs } from '../../src/index.ts';

const SECRET = 's3cr3t';
const NODE_PEER = 'test/interop/_node-peer.ts';

@Provider({ provides: 'config', export: true })
class Config {
  provide() {
    return { config: { region: 'mx', runtime: 'deno' } };
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

const controlUrl = (port: number) => `ws://127.0.0.1:${port}/__mesh__/control`;

/** Spawns the Node peer under tsx, streaming its stdout lines. */
function spawnNodePeer(args: string[]) {
  const child = new Deno.Command('npx', {
    args: ['tsx', NODE_PEER, ...args],
    env: { ...Deno.env.toObject(), MESH_SECRET: SECRET },
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();

  return child;
}

/** Reads stdout until a JSON line parses, or the peer dies / we run out of patience. */
async function firstJsonLine(child: Deno.ChildProcess, timeoutMs = 30_000): Promise<any> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          return JSON.parse(trimmed);
        } catch {
          /* partial line; keep reading */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  throw new Error(`node peer produced no JSON line within ${timeoutMs}ms`);
}

async function kill(child: Deno.ChildProcess): Promise<void> {
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  await child.status;
  try {
    await child.stdout.cancel();
    await child.stderr.cancel();
  } catch {
    /* already released */
  }
}

Deno.test('interop: a Deno teacup consumes a Node teapot', async () => {
  const node = spawnNodePeer(['teapot']);
  const { port } = await firstJsonLine(node);

  const teacup = createApp({
    modules: [TeacupModule],
    experimental: true,
    mesh: { teapots: [{ url: controlUrl(port), secret: SECRET }], timeoutMs: 5000 },
  });

  try {
    const res = await teacup.fetch(new Request('http://x/api/local/who', { headers: { 'x-token': 'abc' } }));
    assertEquals(res.status, 200);
    // the config came from the Node process: proof the scope crossed the runtime boundary
    assertEquals(await res.json(), {
      config: { region: 'mx', runtime: 'node' },
      auth: { token: 'abc' },
    });
  } finally {
    await teacup.close();
    await kill(node);
  }
});

Deno.test('interop: a Node teacup consumes a Deno teapot', async () => {
  const teapot = createApp({ modules: [TeapotModule], experimental: true, mesh: { secret: SECRET } });
  let port = 0;
  const { serveDeno } = await import('../../src/deno.ts');
  const server = serveDeno(teapot, {
    port: 0,
    onListen: (addr) => {
      port = addr.port;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const node = spawnNodePeer(['teacup', controlUrl(port)]);

  try {
    const result = await firstJsonLine(node);
    assertEquals(result.ok, true);
    // the Node peer resolved a scope served by Deno's app.upgrade control channel
    assertEquals(result.body.config, { region: 'mx', runtime: 'deno' });
    assertEquals(result.body.auth, { token: 'abc' });
  } finally {
    await kill(node);
    await server.shutdown();
  }
});

Deno.test('interop: a version-skewed peer is refused across runtimes', async () => {
  const node = spawnNodePeer(['teapot']);
  const { port } = await firstJsonLine(node);

  try {
    // hand-rolled peer speaking a future protocol: the teapot must refuse before the secret
    const ws = new WebSocket(controlUrl(port));
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', v: 999, secret: SECRET }));
      ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
      ws.onerror = () => reject(new Error('ws error'));
    });

    assertEquals(closed.code, 1008);
    assertStringIncludes(closed.reason, '999');
  } finally {
    await kill(node);
  }
});

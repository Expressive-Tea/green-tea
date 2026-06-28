import { createApp, Provider, Step, Route, Get, Module, Transformer, JsonTransformer, Unauthorized, Plugin, needs, param, Sse, Ws, inbound, channel, MESH_CONTROL_PATH } from '../src/index';

interface User { id: string; name: string }

@Provider({ provides: 'db' })
class Database {
  provide() {
    const users: Record<string, User> = { u1: { id: 'u1', name: 'Diego' } };
    return { db: { find: (token: string) => users[token] ?? null } };
  }
}

@Step({ provides: 'user', needs: ['db', 'req'] })
class Authenticate {
  run(ctx: { db: { find: (t: string) => User | null }; req: { headers: Record<string, string> } }) {
    const user = ctx.db.find(ctx.req.headers['x-token']);
    if (!user) throw new Unauthorized('invalid token');
    return { user };
  }
}

@Route('/users')
class UserController {
  @Get('/:id')
  @Transformer(JsonTransformer)
  getUser(@needs('user') user: User, @param('id') id: string) {
    return { requested: id, you: user };
  }
}

@Module({ mountpoint: '/api', providers: [Database], steps: [Authenticate], controllers: [UserController] })
class ApiModule {}

const logger: Plugin = (api) => {
  api.bus.on('request:step:enter', (p) => console.log(`-> ${p.name}`));
};

export const app = createApp({ modules: [ApiModule], plugins: [logger] });

@Route('/feed')
class FeedController {
  @Sse('/ticks')
  ticks() {
    return (async function* () {
      for (let n = 1; n <= 3; n++) yield { tick: n };
    })();
  }
}

@Route('/chat')
class ChatController {
  @Ws('/echo')
  echo(@inbound() incoming: AsyncIterable<string>) {
    const out = channel<string>();
    (async () => {
      for await (const msg of incoming) out.push(`echo: ${msg}`);
      out.close();
    })();
    return out;
  }
}

@Module({ mountpoint: '/', controllers: [FeedController, ChatController] })
class StreamModule {}

export const streamApp = createApp({ modules: [StreamModule] });

if (require.main === module) {
  console.log('chain for /api/users/:id ->', app.inspect('/api/users/:id'));
  console.log('graph:\n' + app.toMermaid());
  console.log('explain /api/users/:id:', app.explain('/api/users/:id'));
  app.listen(3000).then(() => console.log('green-tea on http://localhost:3000'));
  streamApp.listen(3001).then(() => console.log('green-tea streams on http://localhost:3001'));
}

// ── Mesh Demo (teapot / teacup) ───────────────────────────────────────────

@Provider({ provides: 'config', export: true })
class ConfigProvider {
  provide() {
    return { config: { env: 'demo' } };
  }
}

@Step({ provides: 'auth', needs: [], export: true })
class AuthStep {
  run(ctx: { headers?: Record<string, string | string[] | undefined> }) {
    const tok = ctx.headers?.['x-token'];
    return { auth: Array.isArray(tok) ? tok[0] ?? 'anonymous' : tok ?? 'anonymous' };
  }
}

@Route('/svc')
class PingController {
  @Get('/ping', { export: true })
  ping(@needs('config') config: { env: string }, @needs('auth') auth: string) {
    return { pong: true, config, auth };
  }
}

@Module({ mountpoint: '/mesh', providers: [ConfigProvider], steps: [AuthStep], controllers: [PingController] })
class TeapotModule {}

export const teapotApp = createApp({ modules: [TeapotModule], mesh: { secret: 'demo-secret' } });

@Route('/remote')
class TeacupController {
  @Get('/status')
  status(@needs('config') config: { env: string }, @needs('auth') auth: string) {
    return { via: 'teacup', config, auth };
  }
}

@Module({ mountpoint: '/', controllers: [TeacupController] })
class TeacupModule {}

if (require.main === module) {
  teapotApp.listen(3002).then(() => {
    console.log('teapot on http://localhost:3002');
    const teacupApp = createApp({
      modules: [TeacupModule],
      mesh: { teapots: [{ url: `ws://127.0.0.1:3002${MESH_CONTROL_PATH}`, secret: 'demo-secret' }] },
    });
    teacupApp.listen(3003).then(() => console.log('teacup on http://localhost:3003'));
  });
}

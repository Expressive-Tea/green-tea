import { createApp, Provider, Step, Route, Get, Module, Transformer, JsonTransformer, Unauthorized, Plugin, needs, param } from '../src/index';

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

if (require.main === module) {
  console.log('chain for /api/users/:id ->', app.inspect('/api/users/:id'));
  app.listen(3000).then(() => console.log('green-tea on http://localhost:3000'));
}

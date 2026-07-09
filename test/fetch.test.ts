import { describe, it, expect } from 'vitest';
import { createApp, Provider, Route, Get, Post, Module, needs, body } from '../src/index';

@Provider({ provides: 'store' })
class Store {
  provide() {
    return { store: { hi: 'ok' } };
  }
}
@Route('/api')
class Ctl {
  @Get('/hello') hello(@needs('store') s: any) {
    return { store: s.hi };
  }
  @Post('/echo') echo(@body() b: any) {
    return { got: b };
  }
}
@Module({ mountpoint: '/', providers: [Store], controllers: [Ctl] })
class M {}
const app = createApp({ modules: [M] });

describe('app.fetch', () => {
  it('handles GET and returns JSON 200', async () => {
    const res = await app.fetch(new Request('http://x/api/hello'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ store: 'ok' });
  });
  it('parses a POST body', async () => {
    const res = await app.fetch(
      new Request('http://x/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });
  it('404s an unknown route', async () => {
    const res = await app.fetch(new Request('http://x/nope'));
    expect(res.status).toBe(404);
  });
  it('sets secure-by-default headers', async () => {
    const res = await app.fetch(new Request('http://x/api/hello'));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

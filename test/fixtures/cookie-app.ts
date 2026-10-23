// CARD-14 (#113): one graph for the Deno and Bun cookie suites, so both prove the same thing the
// Node suite (test/cookies.test.ts) does — two cookies on one response arrive as two lines.
import { Route, Get, Module, Transformer, HttpError, cookie, setCookie } from '../../src/index';

export const C1 = setCookie('a', '1');
export const C2 = setCookie('b', '2', { maxAge: 60 });

@Route('/c')
class CookieCtl {
  @Get('/one')
  one(@cookie('a') a: string | undefined, @cookie('b') b: string | undefined) {
    return { a: a ?? null, b: b ?? null };
  }

  @Get('/two')
  @Transformer(() => ({ headers: { 'set-cookie': [C1, C2], 'x-custom': ['a', 'b'] }, body: '{}' }))
  two() {
    return null;
  }

  @Get('/error')
  error() {
    throw new HttpError(401, 'nope', undefined, { 'set-cookie': [C1, C2] });
  }
}

@Module({ mountpoint: '/', controllers: [CookieCtl] })
export class CookieModule {}

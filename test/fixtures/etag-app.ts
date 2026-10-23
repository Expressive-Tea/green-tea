// CARD-15 (#114): one graph for the Deno, Bun and edge ETag checks (T11), so each runtime answers
// the same T1/T5 the Node suite (test/etag.test.ts) does.
import { Route, Get, Module } from '../../src/index';

@Route('/h')
class EtagCtl {
  @Get('/json')
  json() {
    return { n: 1 };
  }
}

@Module({ mountpoint: '/', controllers: [EtagCtl] })
export class EtagModule {}

/** A committed file the static checks can serve: `asset.txt` under `test/fixtures/views`. */
export const STATIC_DIR = 'test/fixtures/views';

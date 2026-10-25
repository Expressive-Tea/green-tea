// Worker entry for test/edge/dist.ts: the npm ESM build as an app installs it, not `src/`.
import { createApp, Route, Get, Module } from '../../dist/index.mjs';
import { edgeHandler } from '../../dist/edge.mjs';

@Route('/rt')
class Rt {
  @Get('/hello')
  hello() {
    return { ok: true };
  }
}

@Module({ mountpoint: '/', controllers: [Rt] })
class AppModule {}

export default { fetch: edgeHandler(createApp({ modules: [AppModule] })) };

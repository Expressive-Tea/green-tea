// CARD-16 (#112): the compression fixture served from real workerd, twice — through `edgeHandler`
// (T13) and as a bare `app.fetch` export (T16, reached with `Host: bare`). Core must never encode
// in either; the platform (miniflare locally, Cloudflare when deployed) may. See compression.ts.
import { edgeHandler } from '../../src/edge';
import { compressionApp } from '../fixtures/compression-app';

const viaHandler = edgeHandler(compressionApp({ compression: true }));
const bare = compressionApp({ compression: true });

export default {
  fetch: (request: Request, env?: unknown, ctx?: Parameters<typeof viaHandler>[2]) =>
    new URL(request.url).hostname === 'bare' ? bare.fetch(request) : viaHandler(request, env, ctx),
};

// `@Html` and `static` under the real Deno runtime, importing `src/` the way JSR serves it.
//
// This is the shape the JSR package actually ships: no bundler ran, so tsup's `createRequire`
// banner (tsup.config.ts) never existed and the lazy `require('node:fs')` in `src/views.ts` has
// nothing to resolve. Every other Deno test here imports `src/` too, but none of them touches a
// path that loads a Node builtin lazily — which is how a package that dies at boot on Deno kept a
// green suite. Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import { createApp, Route, Get, Html, Module } from '../../src/index.ts';

// Committed fixtures rather than a temp dir, so the suite keeps running without `--allow-write`.
const dir = 'test/fixtures/views';

@Route('/')
class Views {
  @Get('/dash') @Html('dash.html') dash() {}
  @Get('/user') @Html('user.html', { template: true }) user() {
    return { name: 'Deno' };
  }
}

@Module({ mountpoint: '/', controllers: [Views] })
class M {}

Deno.test("@Html file mode reads the file — the require path resolves without tsup's banner", async () => {
  const app = createApp({ modules: [M], views: dir });
  const res = await app.fetch(new Request('http://x/dash'));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), '<h1>Dash</h1>');
  await app.close();
});

Deno.test('@Html template mode renders', async () => {
  const app = createApp({ modules: [M], views: dir });
  const res = await app.fetch(new Request('http://x/user'));
  assertStringIncludes(await res.text(), 'Hi Deno');
  await app.close();
});

// Deno has a filesystem, so `static` must not report the runtime as the reason for anything.
Deno.test('static: true builds a resolver instead of blaming the runtime', async () => {
  const app = createApp({ modules: [], static: dir });
  const res = await app.fetch(new Request('http://x/asset.txt'));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), 'served');
  await app.close();
});

// The other half of the shim: `node:fs` above comes from `process.getBuiltinModule`, but `busboy`
// is an npm package and has to be resolved from the application's own `node_modules`. On JSR that
// failed as a `ReferenceError` under the catch that reports "busboy not installed" — the one
// diagnosis guaranteed to send a reader to reinstall a package they already have.
Deno.test('multipart resolves the busboy peer dependency instead of reporting it missing', async () => {
  const { createApp: create, Route: R, Post, Module: Mod, body } = await import('../../src/index.ts');

  @R('/')
  class Upload {
    @Post('/up') up(@body() b: { fields: Record<string, string>; files: Record<string, { filename: string }> }) {
      return { name: b.fields.name, filename: b.files.file.filename };
    }
  }

  @Mod({ mountpoint: '/', controllers: [Upload] })
  class UploadMod {}

  const app = create({ modules: [UploadMod] });
  const form = new FormData();
  form.set('name', 'joe');
  form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'p.png');

  const res = await app.fetch(new Request('http://x/up', { method: 'POST', body: form }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { name: 'joe', filename: 'p.png' });
  await app.close();
});

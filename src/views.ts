// src/views.ts — HTML views: built-in templating, content-type map, and boot-time builders.
// fs/path are lazy-required inside functions so the barrel stays edge-loadable (workerd has no filesystem).

import type { TransformerFn } from './metadata';
import type { HtmlMeta } from './metadata';
import { nodeRequire } from './node-require';

/** Escape the five HTML-significant characters so interpolated data can't inject markup. */
export function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function stringify(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Minimal built-in template engine: `{{ key }}` interpolates HTML-escaped, `{{{ key }}}` raw,
 * `{{ a.b }}` walks nested keys, a missing key renders empty. No loops/conditionals/partials.
 */
export function render(source: string, data: unknown): string {
  const lookup = (key: string): unknown =>
    key.split('.').reduce<any>((obj, k) => (obj === null || obj === undefined ? undefined : obj[k]), data);
  return source
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => stringify(lookup(key)))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escapeHtml(stringify(lookup(key))));
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Content-type for a file extension (case-insensitive, leading dot); unknown → `application/octet-stream`. */
export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;

/** Boot-time context for building `@Html` transformers: the views base dir and an optional BYO engine. */
export interface ViewsContext {
  views?: string;
  viewEngine?: (source: string, data: unknown) => string;
}

/** Reads a view file at boot (lazy fs). Relative paths resolve against `views` (default cwd); absolute as-is.
 * node:fs/node:path are loaded lazily so importing the barrel stays edge/workerd-safe
 * (workerd's nodejs_compat provides no filesystem). This path only runs for path/template `@Html` modes.
 * Unguarded on purpose: `@Html('file')` cannot degrade into anything useful, so a runtime with no
 * filesystem should hear about it here rather than at the first request. */
function readViewFile(views: string | undefined, path: string): string {
  const nodePath = nodeRequire<typeof import('node:path')>('node:path');
  const fs = nodeRequire<typeof import('node:fs')>('node:fs');
  const base = views ?? process.cwd();
  const full = nodePath.isAbsolute(path) ? path : nodePath.resolve(base, path);

  try {
    return fs.readFileSync(full, 'utf8');
  } catch (err) {
    throw new Error(
      `@Html('${path}') could not read '${full}' — on a runtime without a filesystem (edge), return a string from @Html instead. (${(err as Error).message})`,
    );
  }
}

/**
 * A static-file hit: what the `stat` already knows, and a `read()` for the bytes.
 *
 * The bytes are behind a function so the caller can answer a conditional request from `size` and
 * `mtimeMs` alone: a `304` never reads the file (CARD-15). `read()` reads the confined real path the
 * resolver checked, so deferring it does not reopen the path to a different target.
 */
export interface StaticHit {
  contentType: string;
  size: number;
  mtimeMs: number;
  /** `Cache-Control` for this hit (and its `304`): `no-cache` unless `static.cacheControl` says otherwise. */
  cacheControl: string;
  read(): Promise<Buffer>;
}

/** Resolves a URL path to a static file under a fixed root, or `undefined` for a miss. */
export type StaticResolver = (urlPath: string) => Promise<StaticHit | undefined>;

/**
 * The public `static` option: `true` (→ `./public`), a directory, or `{ dir?, cacheControl? }`.
 * `cacheControl` defaults to `'no-cache'`, so a browser always revalidates — cheap, since a match is a
 * `304` that never reads the file — and never reuses a file heuristically from `Last-Modified`
 * (RFC 9111 §4.2.2). Hashed assets can opt into `'public, max-age=31536000, immutable'`.
 */
export type StaticOption = boolean | string | { dir?: string; cacheControl?: string };

const STATIC_KEYS = new Set(['dir', 'cacheControl']);

/**
 * Validates and normalises the `static` option at boot. Throws on an unknown key in the object form
 * (a misspelt `cachecontrol` silently doing nothing is the bug this prevents), on a non-string
 * `dir`/`cacheControl`, and on a `cacheControl` carrying CR or LF (header injection).
 */
export function normalizeStatic(
  option: StaticOption | undefined,
): { root: string | true; cacheControl: string } | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true || typeof option === 'string') return { root: option, cacheControl: 'no-cache' };

  if (typeof option !== 'object' || option === null)
    throw new TypeError('createApp({ static }): expected a boolean, a directory string or { dir?, cacheControl? }');

  for (const key of Object.keys(option))
    if (!STATIC_KEYS.has(key))
      throw new TypeError(`createApp({ static }): unknown key '${key}' — expected 'dir' and/or 'cacheControl'`);

  const { dir, cacheControl = 'no-cache' } = option;
  if (dir !== undefined && typeof dir !== 'string')
    throw new TypeError('createApp({ static: { dir } }): expected a string');

  if (typeof cacheControl !== 'string' || /[\r\n]/.test(cacheControl))
    throw new TypeError('createApp({ static: { cacheControl } }): expected a string without CR or LF');

  return { root: dir ?? true, cacheControl };
}

/** The real path of `path` when it is `root` or lies beneath it, else `undefined`. Rejects on ENOENT.
 * The separator suffix keeps a sibling such as `root-evil` out of `root`. */
async function confine(fs: typeof import('node:fs'), sep: string, root: string, path: string) {
  const real = await fs.promises.realpath(path);
  return real === root || real.startsWith(root + sep) ? real : undefined;
}

/** Stats `full` (or its `index.html` when a directory) if its real path stays inside the real `root`. */
async function statConfined(
  fs: typeof import('node:fs'),
  nodePath: typeof import('node:path'),
  root: string,
  full: string,
  cacheControl: string,
): Promise<StaticHit | undefined> {
  let real = await confine(fs, nodePath.sep, root, full);
  if (!real) return undefined;
  let stat = await fs.promises.stat(real);
  const isDir = stat.isDirectory();

  // `index.html` is a second resolution and can itself be a link, so it is confined on its own.
  if (isDir) {
    real = await confine(fs, nodePath.sep, root, nodePath.join(real, 'index.html'));
    if (!real) return undefined;
    stat = await fs.promises.stat(real);
  }

  const path = real;
  // The content-type follows the requested name, not the link target (`app.js -> app.3f2a.js`).
  const target = isDir ? nodePath.join(full, 'index.html') : full;
  return {
    contentType: contentTypeFor(nodePath.extname(target)),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    cacheControl,
    // ponytail: a link swapped between `realpath` and `readFile` can still escape. Exploiting it needs
    // write access inside the served root, which already owns the app; closing it needs `O_NOFOLLOW`
    // on every path component, which Node, Deno and Bun do not offer portably.
    read: () => fs.promises.readFile(path),
  };
}

/**
 * Builds a static-file resolver rooted at `root` (`true` → `./public`). Requires a filesystem: throws at
 * boot on a runtime without one (edge). Path-traversal-safe — a resolved path outside the root is a miss,
 * and so is a symlink whose real target lies outside the root's real path (#106). Escapes are misses
 * (404), not 403, so a probe cannot tell "exists outside the root" from "does not exist".
 */
export function buildStaticResolver(root: string | true, cacheControl = 'no-cache'): StaticResolver {
  let fs: typeof import('node:fs');
  let nodePath: typeof import('node:path');

  try {
    fs = nodeRequire('node:fs');
    nodePath = nodeRequire('node:path');
  } catch {
    throw new Error(
      '`static` needs a filesystem and is unavailable on this runtime (edge). Remove it or serve assets from a CDN.',
    );
  }

  const abs = nodePath.resolve(process.cwd(), root === true ? 'public' : root);

  // The root's real path, resolved once on the first request rather than at build time, so a missing
  // `public/` at boot is still not fatal — it just makes every request a miss, as before. Containment
  // compares real paths, so the root must be real too: a symlinked `public/` would otherwise fail every
  // check. Cached for the life of the app: re-pointing a root symlink at runtime needs a restart. A failed
  // lookup is not cached, so a root created after boot starts serving, as it did before.
  let realRoot: Promise<string | undefined> | undefined;
  const resolveRoot = () =>
    (realRoot ??= fs.promises.realpath(abs).catch(() => {
      realRoot = undefined;
      return undefined;
    }));

  return async (urlPath) => {
    let rel: string;

    try {
      rel = decodeURIComponent(urlPath.split('?')[0]);
    } catch {
      return undefined;
    }

    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const full = nodePath.resolve(abs, '.' + (rel.startsWith('/') ? rel : '/' + rel));
    if (full !== abs && !full.startsWith(abs + nodePath.sep)) return undefined; // traversal guard

    const rootReal = await resolveRoot();
    if (!rootReal) return undefined;

    try {
      return await statConfined(fs, nodePath, rootReal, full, cacheControl);
    } catch {
      return undefined; // includes ENOENT from `realpath` on a dangling link: a miss, never a rejection
    }
  };
}

/** Turns `@Html` metadata into a response transformer at boot. String mode is fs-free; path/template modes read+cache the file. */
export function buildHtmlTransformer(meta: HtmlMeta, ctx: ViewsContext): TransformerFn {
  if (!meta.path) {
    return (value) => ({ status: 200, headers: { ...HTML_HEADERS }, body: String(value) });
  }

  const source = readViewFile(ctx.views, meta.path);

  if (meta.template) {
    const engine = ctx.viewEngine ?? render;
    return (value) => ({ status: 200, headers: { ...HTML_HEADERS }, body: engine(source, value) });
  }

  return () => ({ status: 200, headers: { ...HTML_HEADERS }, body: source });
}

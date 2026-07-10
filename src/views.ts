// src/views.ts — HTML views: built-in templating, content-type map, and boot-time builders.
// fs/path are lazy-required inside functions so the barrel stays edge-loadable (workerd has no filesystem).

import type { TransformerFn } from './metadata';
import type { HtmlMeta } from './metadata';

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
 * (workerd's nodejs_compat provides no filesystem). This path only runs for path/template `@Html` modes. */
function readViewFile(views: string | undefined, path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
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

/** A static-file hit: the raw bytes and the content-type to send. */
export interface StaticHit {
  body: Buffer;
  contentType: string;
}

/** Resolves a URL path to a static file under a fixed root, or `undefined` for a miss. */
export type StaticResolver = (urlPath: string) => Promise<StaticHit | undefined>;

/**
 * Builds a static-file resolver rooted at `root` (`true` → `./public`). Requires a filesystem: throws at
 * boot on a runtime without one (edge). Path-traversal-safe — a resolved path outside the root is a miss.
 */
export function buildStaticResolver(root: string | true): StaticResolver {
  let fs: typeof import('node:fs');
  let nodePath: typeof import('node:path');

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodePath = require('node:path');
  } catch {
    throw new Error(
      '`static` needs a filesystem and is unavailable on this runtime (edge). Remove it or serve assets from a CDN.',
    );
  }

  const abs = nodePath.resolve(process.cwd(), root === true ? 'public' : root);

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

    try {
      const stat = await fs.promises.stat(full);
      const target = stat.isDirectory() ? nodePath.join(full, 'index.html') : full;
      const body = await fs.promises.readFile(target);
      return { body, contentType: contentTypeFor(nodePath.extname(target)) };
    } catch {
      return undefined;
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

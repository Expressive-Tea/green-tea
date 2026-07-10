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

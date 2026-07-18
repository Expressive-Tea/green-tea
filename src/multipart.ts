// src/multipart.ts — multipart/form-data parsing on top of the optional `busboy` peer dependency.
import { Readable } from 'stream';
import { HttpError } from './signals';

/** A single uploaded file part decoded from a multipart body. */
export interface UploadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
  size: number;
}

/** Decoded multipart body: text fields and file uploads, keyed by part name. */
export interface MultipartBody {
  fields: Record<string, string | string[]>;
  files: Record<string, UploadedFile | UploadedFile[]>;
}

/** Parser limits and duplicate-key policy for {@link parseMultipart}. */
export interface MultipartOpts {
  maxParts: number;
  duplicates: 'array' | 'last';
}

/**
 * Extracts the boundary token from a Content-Type value (supports the quoted form).
 * @returns The boundary, or undefined when absent.
 */
export function extractBoundary(contentType: string): string | undefined {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  return boundary || undefined;
}

function addField(fields: MultipartBody['fields'], name: string, value: string, duplicates: 'array' | 'last'): void {
  if (duplicates === 'array') {
    const existing = fields[name];
    if (Array.isArray(existing)) existing.push(value);
    else fields[name] = [value];
  } else {
    fields[name] = value; // last-wins
  }
}

/**
 * Collapses an iterable of [key, value] pairs (e.g. URLSearchParams) into an object,
 * applying the same duplicate-key policy as multipart fields so urlencoded bodies behave identically.
 */
export function collapseDuplicates(
  pairs: Iterable<[string, string]>,
  duplicates: 'array' | 'last',
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of pairs) addField(out, key, value, duplicates);
  return out;
}

function addFile(files: MultipartBody['files'], name: string, file: UploadedFile): void {
  const existing = files[name];
  if (existing === undefined) files[name] = file;
  else if (Array.isArray(existing)) existing.push(file);
  else files[name] = [existing, file];
}

/** Lazily loads the optional `busboy` peer dependency, or null when it is not installed. */
function loadBusboy(): ((cfg: unknown) => NodeJS.WritableStream & NodeJS.EventEmitter) | null {
  try {
    // `busboy` is an OPTIONAL peer dependency: only multipart uploads need it, so it is
    // lazy-required and its absence surfaces as a clear 501 rather than a load-time crash.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('busboy');
  } catch {
    return null;
  }
}

/**
 * Parses a raw multipart/form-data buffer into decoded fields and files, using `busboy`.
 * @param raw The full (already size-capped) request body.
 * @param boundary The boundary token (see {@link extractBoundary}).
 * @throws HttpError 501 when the optional `busboy` peer dependency is not installed.
 * @throws Error 'Invalid multipart body' on malformed input or when `maxParts` is exceeded.
 */
export function parseMultipart(raw: Buffer, boundary: string, opts: MultipartOpts): Promise<MultipartBody> {
  const busboy = loadBusboy();

  if (!busboy) {
    throw new HttpError(501, 'multipart/form-data requires the optional "busboy" peer dependency — run `npm i busboy`');
  }

  return new Promise<MultipartBody>((resolve, reject) => {
    const body: MultipartBody = { fields: {}, files: {} };
    const fail = () => reject(new Error('Invalid multipart body'));
    let bb: NodeJS.WritableStream & NodeJS.EventEmitter;

    try {
      bb = busboy({
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        limits: { parts: opts.maxParts },
      });
    } catch {
      return fail();
    }

    bb.on('field', (name: string, value: string) => addField(body.fields, name, value, opts.duplicates));

    bb.on('file', (name: string, stream: Readable, info: { filename?: string; mimeType?: string }) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('close', () => {
        const data = Buffer.concat(chunks);
        const filename = info.filename ?? '';
        if (filename === '' && data.length === 0) return; // unselected file input

        addFile(body.files, name, {
          filename,
          contentType: info.mimeType || 'application/octet-stream',
          data,
          size: data.length,
        });
      });
    });

    bb.on('partsLimit', fail); // more parts than maxParts → treat as malformed (matches prior behavior)
    bb.on('error', fail);
    bb.on('close', () => resolve(body));

    Readable.from(raw).pipe(bb);
  });
}

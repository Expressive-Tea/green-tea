// src/multipart.ts — pure, binary-safe multipart/form-data parser. No server deps.
export interface UploadedFile { filename: string; contentType: string; data: Buffer; size: number }
export interface MultipartBody {
  fields: Record<string, string | string[]>;
  files: Record<string, UploadedFile | UploadedFile[]>;
}
export interface MultipartOpts { maxParts: number; duplicates: 'array' | 'last' }

const CRLF = Buffer.from('\r\n');

// boundary token from a Content-Type value; supports quoted form.
export function extractBoundary(contentType: string): string | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const b = (m?.[1] ?? m?.[2])?.trim();
  return b || undefined;
}

// order-independent, quoted-or-unquoted param lookup within a header value.
// The `(?:^|[;\s])` prefix anchors the key to a param boundary so `name=` does NOT
// match the tail of `filename=`, and `filename=` does not match `filename*=`.
function param(header: string, key: string): string | undefined {
  const q = new RegExp(`(?:^|[;\\s])${key}="([^"]*)"`, 'i').exec(header);
  if (q) return q[1];
  const u = new RegExp(`(?:^|[;\\s])${key}=([^";]+)`, 'i').exec(header);
  return u ? u[1].trim() : undefined;
}

function addField(fields: MultipartBody['fields'], name: string, value: string, dup: 'array' | 'last'): void {
  if (dup === 'array') {
    const ex = fields[name];
    if (Array.isArray(ex)) ex.push(value);
    else fields[name] = [value];
  } else {
    fields[name] = value; // last-wins
  }
}

// Reusable accumulator for any iterable of [key, value] pairs (e.g. URLSearchParams)
// so urlencoded bodies collapse duplicates with the exact same policy as multipart fields.
export function collapseDuplicates(
  pairs: Iterable<[string, string]>, dup: 'array' | 'last',
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of pairs) addField(out, k, v, dup);
  return out;
}

function addFile(files: MultipartBody['files'], name: string, file: UploadedFile): void {
  const ex = files[name];
  if (ex === undefined) files[name] = file;
  else if (Array.isArray(ex)) ex.push(file);
  else files[name] = [ex, file];
}

// Find the next REAL delimiter at/after `from`: a `\r\n--boundary` occurrence that is
// followed by `\r\n` (a part) or `--` (the terminator). This skips false hits where the
// exact `\r\n--boundary` byte sequence appears INSIDE a file body — the data-integrity case.
function findDelim(buf: Buffer, delim: Buffer, from: number): number {
  let i = buf.indexOf(delim, from);
  while (i !== -1) {
    const a = i + delim.length;
    if ((buf[a] === 0x0d && buf[a + 1] === 0x0a) || (buf[a] === 0x2d && buf[a + 1] === 0x2d)) return i;
    i = buf.indexOf(delim, i + delim.length); // false hit inside a body — keep searching
  }
  return -1;
}

export function parseMultipart(raw: Buffer, boundary: string, opts: MultipartOpts): MultipartBody {
  const fields: MultipartBody['fields'] = {};
  const files: MultipartBody['files'] = {};
  const delim = Buffer.concat([CRLF, Buffer.from(`--${boundary}`)]); // \r\n--boundary
  // Normalize: prepend CRLF so the FIRST boundary (which a browser sends with no
  // leading CRLF) is also preceded by the delimiter and isn't dropped as preamble.
  const buf = Buffer.concat([CRLF, raw]);

  let pos = findDelim(buf, delim, 0);
  if (pos === -1) throw new Error('Invalid multipart body');
  let count = 0;
  while (true) {
    let start = pos + delim.length;
    // terminator "--" immediately after the boundary → done
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    // skip the CRLF that ends the boundary line
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    const next = findDelim(buf, delim, start);
    if (next === -1) throw new Error('Invalid multipart body');
    if (++count > opts.maxParts) throw new Error('Invalid multipart body');
    const part = buf.subarray(start, next);
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) throw new Error('Invalid multipart body');
    const headerText = part.subarray(0, sep).toString('utf8');
    const partBody = part.subarray(sep + 4);

    let disposition = '';
    let contentType = '';
    for (const line of headerText.split('\r\n')) {
      const c = line.indexOf(':');
      if (c === -1) continue;
      const k = line.slice(0, c).trim().toLowerCase();
      const v = line.slice(c + 1).trim();
      if (k === 'content-disposition') disposition = v;
      else if (k === 'content-type') contentType = v;
    }

    const name = param(disposition, 'name');
    if (name === undefined) throw new Error('Invalid multipart body');
    const filename = param(disposition, 'filename');
    if (filename !== undefined) {
      if (filename === '' && partBody.length === 0) { pos = next; continue; } // unselected file input
      addFile(files, name, {
        filename,
        contentType: contentType || 'application/octet-stream',
        data: Buffer.from(partBody), // copy out of the shared buffer
        size: partBody.length,
      });
    } else {
      addField(fields, name, partBody.toString('utf8'), opts.duplicates);
    }
    pos = next;
  }
  return { fields, files };
}

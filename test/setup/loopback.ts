// Test servers listen on 127.0.0.1 unless a test names a host (#59).
//
// Every test connects to 127.0.0.1, but `listen(0)` with no host binds `::`. On macOS a `::` bind and a
// `127.0.0.1` bind are different sockets, so the OS can hand a test server on `::` a port that another
// process, or another test file running in parallel, already holds on 127.0.0.1, and the test's client
// reaches that one instead: a fresh server "answered" 404, 403 or "Not yet implemented". A 127.0.0.1
// bind is never given a port already taken on 127.0.0.1, and as the more specific bind it gets the
// traffic. A host makes Node resolve it before binding, so `address()` is only valid after 'listening':
// test helpers wait for it. Production code is untouched; this file is only in vitest's setupFiles.
import net from 'node:net';

const LOOPBACK = '127.0.0.1';
const listen = net.Server.prototype.listen;

net.Server.prototype.listen = function loopbackListen(this: net.Server, ...args: unknown[]) {
  const [first, second] = args;

  if (typeof first === 'number') {
    // listen(port), listen(port, cb), and `ws`'s listen(port, null, null, cb)
    if (second == null) args.length > 1 ? (args[1] = LOOPBACK) : args.push(LOOPBACK);
    else if (typeof second === 'function') args.splice(1, 0, LOOPBACK);
  } else if (first !== null && typeof first === 'object' && !('path' in first) && !(first as { host?: unknown }).host) {
    args[0] = { ...first, host: LOOPBACK };
  }

  return listen.apply(this, args as Parameters<typeof listen>);
} as typeof listen;

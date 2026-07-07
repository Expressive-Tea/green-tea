import http from 'http';

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const send = (obj: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && url === '/hello') return send({ hello: 'world' });
  if (req.method === 'GET' && url.startsWith('/users/')) return send({ id: url.slice('/users/'.length) });
  if (req.method === 'GET' && url === '/pipeline') { const s: any = {}; [1, 2, 3].forEach((n) => (s[`s${n}`] = n)); return send({ hello: 'world', s3: s.s3 }); }
  if (req.method === 'GET' && url === '/steps/0') return send({ hello: 'world' });
  if (req.method === 'POST' && url === '/validate') {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      try { const b = JSON.parse(raw); if (typeof b.email === 'string' && b.email.includes('@')) return send({ email: b.email }); return send({ error: 'invalid' }, 422); }
      catch { return send({ error: 'bad json' }, 400); }
    }); return;
  }
  send({ error: 'not found' }, 404);
});
server.keepAliveTimeout = 5000;
server.listen(0, () => console.log(`READY ${(server.address() as any).port}`));

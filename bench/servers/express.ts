import express from 'express';

const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(express.json());
app.get('/hello', (_req, res) => { res.json({ hello: 'world' }); });
app.get('/users/:id', (req, res) => { res.json({ id: req.params.id }); });
const mw = (n: number) => (_req: any, res: any, next: any) => { res.locals[`s${n}`] = n; next(); };
app.get('/pipeline', mw(1), mw(2), mw(3), (_req, res) => { res.json({ hello: 'world', s3: res.locals.s3 }); });
app.post('/validate', (req: any, res) => {
  const b = req.body;
  if (!(b && typeof b.email === 'string' && b.email.includes('@'))) { res.status(422).json({ error: 'invalid' }); return; }
  res.json({ email: b.email });
});
const server = app.listen(0, () => {
  server.keepAliveTimeout = 5000;
  console.log(`READY ${(server.address() as any).port}`);
});

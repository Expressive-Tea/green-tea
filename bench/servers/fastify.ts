import Fastify from 'fastify';

const app = Fastify({ logger: false, keepAliveTimeout: 5000 });
app.get('/hello', async () => ({ hello: 'world' }));
app.get('/users/:id', async (req: any) => ({ id: req.params.id }));
const hook = (n: number) => (req: any, _res: any, done: any) => { req[`s${n}`] = n; done(); };
app.get('/pipeline', { preHandler: [hook(1), hook(2), hook(3)] }, async (req: any) => ({ hello: 'world', s3: req.s3 }));
app.post('/validate', {
  schema: { body: { type: 'object', required: ['email'], properties: { email: { type: 'string' } } } },
}, async (req: any, reply) => {
  const b = req.body;
  if (!b.email.includes('@')) { reply.code(422); return { error: 'invalid' }; }
  return { email: b.email };
});
app.listen({ port: 0, host: '0.0.0.0' }, (err, addr) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`READY ${Number(new URL(addr).port)}`);
});

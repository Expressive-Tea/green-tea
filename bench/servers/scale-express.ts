import express from 'express';

// Express counterpart: /chain/N runs N trivial middlewares before the handler —
// the closest apples-to-apples to green-tea's N chained steps.
const app = express();
app.disable('x-powered-by');
app.set('etag', false);

const mw = (_req: any, _res: any, next: any) => next();

function route(path: string, n: number): void {
  const chain = Array.from({ length: n }, () => mw);
  app.get(path, ...chain, (_req, res) => { res.json({ ok: 1 }); });
}

route('/chain/0', 0);
route('/chain/10', 10);
route('/chain/25', 25);
route('/chain/50', 50);
route('/chain/75', 75);
route('/chain/100', 100);

const server = app.listen(0, () => {
  server.keepAliveTimeout = 5000;
  console.log(`READY ${(server.address() as any).port}`);
});

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import { BenchModule } from './_nest-shared';

async function main() {
  const inst = express();
  inst.disable('x-powered-by');
  inst.set('etag', false);
  const app = await NestFactory.create(BenchModule, new ExpressAdapter(inst), { logger: false });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  server.keepAliveTimeout = 5000; // parity (works on Node http.Server after listen)
  console.log(`READY ${server.address().port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

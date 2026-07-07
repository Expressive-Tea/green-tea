import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BenchModule } from './_nest-shared';

async function main() {
  const adapter = new FastifyAdapter({ logger: false, keepAliveTimeout: 5000 }); // parity via constructor
  const app = await NestFactory.create<NestFastifyApplication>(BenchModule, adapter, { logger: false });
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  console.log(`READY ${(server.address() as any).port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

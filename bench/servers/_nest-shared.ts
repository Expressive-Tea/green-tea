import { Module, Controller, Get, Post, Param, Body, HttpException, MiddlewareConsumer, NestModule } from '@nestjs/common';

@Controller()
export class BenchController {
  @Get('hello') hello() { return { hello: 'world' }; }
  @Get('users/:id') user(@Param('id') id: string) { return { id }; }
  @Get('pipeline') pipeline() { return { hello: 'world', s3: 3 }; }
  @Post('validate') validate(@Body() b: any) {
    if (!(b && typeof b.email === 'string' && b.email.includes('@'))) throw new HttpException({ error: 'invalid' }, 422);
    return { email: b.email };
  }
}

// pipeline parity: 3 middleware hops on /pipeline (approximation of 3 @Steps), adapter-agnostic
const mw = (_n: number) => (_req: any, _res: any, next: any) => next();

@Module({ controllers: [BenchController] })
export class BenchModule implements NestModule {
  configure(c: MiddlewareConsumer) { c.apply(mw(1), mw(2), mw(3)).forRoutes('pipeline'); }
}

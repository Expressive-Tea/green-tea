import { Bus } from './bus';
import { errorToResponse } from './transformers';
import { isAsyncIterable } from './channel';
import type { TransformerFn } from './metadata';

export interface PipelineStep { name: string; origin: string; run: (ctx: any) => any }
export interface ResponseShape { status: number; headers: Record<string, string>; body: string }
export interface StreamResult { stream: AsyncIterable<unknown> }
export type PipelineResult = ResponseShape | StreamResult;

export function isStreamResult(r: PipelineResult): r is StreamResult {
  return 'stream' in r;
}

export async function runPipeline(args: {
  steps: PipelineStep[];
  handler: (ctx: any) => unknown;
  transformer: TransformerFn;
  seed: Record<string, unknown>;
  bus: Bus;
}): Promise<PipelineResult> {
  const { steps, handler, transformer, seed, bus } = args;
  let ctx: any = { ...seed };
  try {
    for (const s of steps) {
      bus.emit('request:step:enter', { name: s.name, scope: s.origin });
      const out = await s.run(ctx);
      ctx = { ...ctx, ...out };
      bus.emit('request:step:leave', { name: s.name, scope: s.origin });
    }
    const result = await handler(ctx);
    if (isAsyncIterable(result)) return { stream: result };   // stream path: transformer bypassed
    const r = transformer(result);
    return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body };
  } catch (error) {
    bus.emit('request:step:error', { name: 'pipeline', error });
    return errorToResponse(error);
  }
}

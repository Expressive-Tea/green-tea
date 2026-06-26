export type StepFn<In, Out> = (ctx: In) => Out | Promise<Out>;

export interface CompiledFlow<Seed, Acc> {
  steps: { name: string; fn: StepFn<any, any> }[];
  handler: (ctx: Acc) => unknown;
  run(seed: Seed): Promise<unknown>;
}

export class Flow<Seed, Acc> {
  constructor(private readonly steps: { name: string; fn: StepFn<any, any> }[] = []) {}

  step<Out>(name: string, fn: StepFn<Acc, Out>): Flow<Seed, Acc & Out> {
    return new Flow<Seed, Acc & Out>([...this.steps, { name, fn }]);
  }

  handle(handler: (ctx: Acc) => unknown): CompiledFlow<Seed, Acc> {
    const steps = this.steps;
    return {
      steps,
      handler,
      async run(seed: Seed): Promise<unknown> {
        let ctx: any = { ...seed };
        for (const s of steps) {
          const out = await s.fn(ctx);
          ctx = { ...ctx, ...out };
        }
        return handler(ctx);
      },
    };
  }
}

export function flow<Seed extends object>(): Flow<Seed, Seed> {
  return new Flow<Seed, Seed>();
}

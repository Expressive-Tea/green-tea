/** A single flow step: receives the accumulated context and returns the fields it contributes. */
export type StepFn<In, Out> = (ctx: In) => Out | Promise<Out>;

/** A built flow ready to execute: its ordered steps, terminal handler, and a `run` entry point. */
export interface CompiledFlow<Seed, Acc> {
  steps: { name: string; fn: StepFn<any, any> }[];
  handler: (ctx: Acc) => unknown;
  run(seed: Seed): Promise<unknown>;
}

/** Immutable builder that chains typed steps, each widening the accumulated context type. */
export class Flow<Seed, Acc> {
  constructor(private readonly steps: { name: string; fn: StepFn<any, any> }[] = []) {}

  /** Appends a step and returns a new Flow whose context now includes the step's output. */
  step<Out>(name: string, fn: StepFn<Acc, Out>): Flow<Seed, Acc & Out> {
    return new Flow<Seed, Acc & Out>([...this.steps, { name, fn }]);
  }

  /** Seals the flow with a terminal handler, producing a runnable CompiledFlow. */
  handle(handler: (ctx: Acc) => unknown): CompiledFlow<Seed, Acc> {
    const steps = this.steps;
    return {
      steps,
      handler,
      async run(seed: Seed): Promise<unknown> {
        let ctx: any = { ...seed };

        for (const step of steps) {
          const output = await step.fn(ctx);
          ctx = { ...ctx, ...output };
        }

        return handler(ctx);
      },
    };
  }
}

/** Starts a new flow whose seed and initial context are the same type. */
export function flow<Seed extends object>(): Flow<Seed, Seed> {
  return new Flow<Seed, Seed>();
}

// Executes the circuit-breaker recipe published at
// https://green-tea.expressive-tea.io/docs/guides/circuit-breaker/
//
// The recipe lives in the documentation repository, which imports nothing from here, so nothing
// fails when the two drift apart. This is the smallest thing that makes the page's load-bearing
// claims executable rather than merely written: that breaker state survives across requests (which
// is why it is a provider and not a step), that the window re-opens, and that a failed trial in
// half-open re-opens immediately instead of earning the threshold again.
//
// Keep the class below identical to the page. If you change one, change both.
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Provider, Module, Route, Get } from '../src/metadata';
import { createApp } from '../src/app';
import { HttpError } from '../src/signals';
import { needs } from '../src/params';

// ---- the recipe, verbatim ---------------------------------------------------------------------

type BreakerState = 'closed' | 'open' | 'half-open';

class CircuitBreaker {
  #state: BreakerState = 'closed';
  #failures = 0;
  #openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): BreakerState {
    return this.#state;
  }

  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#state === 'open') {
      if (this.now() - this.#openedAt < this.resetMs) {
        throw new HttpError(503, 'billing is unavailable');
      }
      this.#state = 'half-open';
    }

    try {
      const result = await operation();
      this.#state = 'closed';
      this.#failures = 0;
      return result;
    } catch (error) {
      this.#failures++;
      if (this.#state === 'half-open' || this.#failures >= this.threshold) {
        this.#state = 'open';
        this.#openedAt = this.now();
      }
      throw error;
    }
  }
}

interface BillingApi {
  charge(userId: string): Promise<{ ok: true }>;
}

@Provider({ provides: 'billing', needs: ['billingApi'] })
class GuardedBilling {
  #breaker = new CircuitBreaker(3, 30_000);

  provide({ billingApi }: { billingApi: BillingApi }) {
    return {
      billing: {
        charge: (userId: string) => this.#breaker.call(() => billingApi.charge(userId)),
      },
      billingBreaker: this.#breaker,
    };
  }
}

// ---- the test ---------------------------------------------------------------------------------

describe('circuit-breaker recipe', () => {
  it('opens after the threshold and short-circuits, sharing state across requests', async () => {
    let calls = 0;

    @Provider({ provides: 'billingApi' })
    class FailingBilling {
      provide() {
        return {
          billingApi: {
            charge: async () => {
              calls++;
              throw new Error('upstream down');
            },
          } satisfies BillingApi,
        };
      }
    }

    @Route('/')
    class Ctl {
      @Get('/pay')
      async pay(@needs('billing') billing: { charge(id: string): Promise<unknown> }) {
        try {
          await billing.charge('u1');
          return { ok: true };
        } catch (error) {
          return { failed: (error as Error).message };
        }
      }
    }

    @Module({ mountpoint: '/', providers: [FailingBilling, GuardedBilling], controllers: [Ctl] })
    class M {}
    const app = createApp({ modules: [M] });

    const hit = async () => (await (await app.fetch(new Request('http://x/pay'))).json()) as { failed: string };

    // Three real attempts trip it; the fourth never reaches the upstream. The breaker survives
    // across requests, which is the whole reason it is a provider and not a step.
    expect((await hit()).failed).toBe('upstream down');
    expect((await hit()).failed).toBe('upstream down');
    expect((await hit()).failed).toBe('upstream down');
    expect(calls).toBe(3);

    expect((await hit()).failed).toBe('billing is unavailable');
    expect(calls).toBe(3); // short-circuited — upstream was not called again

    await app.close();
  });

  it('half-opens after the reset window and closes again on success', async () => {
    let clock = 0;
    let fail = true;
    const breaker = new CircuitBreaker(2, 1000, () => clock);
    const call = () =>
      breaker.call(async () => {
        if (fail) throw new Error('down');
        return 'ok';
      });

    await expect(call()).rejects.toThrow('down');
    await expect(call()).rejects.toThrow('down');
    expect(breaker.state).toBe('open');

    await expect(call()).rejects.toThrow('billing is unavailable'); // still inside the window

    clock = 2000;
    fail = false;
    await expect(call()).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('re-opens when the trial request in half-open fails', async () => {
    let clock = 0;
    const breaker = new CircuitBreaker(1, 1000, () => clock);

    await expect(breaker.call(async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(breaker.state).toBe('open');

    clock = 2000;
    await expect(breaker.call(async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(breaker.state).toBe('open'); // one failed trial is enough, threshold not restarted
  });
});

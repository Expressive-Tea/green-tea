// The teapot: the billing service. It owns the ledger and exports two things over the mesh:
// a step (`balance`) another node can `@needs`, and its REST routes, which a teacup serves as if
// they were its own. The ledger itself is never exported: a mesh export carries data, not handles.
//
//   npx tsx example/mesh/billing.ts      # on :3401, or BILLING_PORT
//
// Mesh is alpha and behind `experimental: true`. See example/README.md for the walkthrough.
import { createApp, Provider, Step, Route, Get, Post, Module, needs, param, body, HttpError } from '../../src/index';

export interface Invoice {
  id: number;
  amount: number;
  paid: boolean;
}

export interface Ledger {
  invoices(customer: string): Invoice[];
  add(customer: string, amount: number): Invoice;
}

/** In-memory, so a restarted billing node starts empty. A real one would hold a database pool here. */
@Provider({ provides: 'ledger' })
class LedgerProvider {
  provide(): { ledger: Ledger } {
    const byCustomer = new Map<string, Invoice[]>([['ada', [{ id: 1, amount: 40, paid: false }]]]);
    let next = 2;

    return {
      ledger: {
        invoices: (customer) => byCustomer.get(customer) ?? [],
        add: (customer, amount) => {
          const invoice = { id: next++, amount, paid: false };
          byCustomer.set(customer, [...(byCustomer.get(customer) ?? []), invoice]);
          return invoice;
        },
      },
    };
  }
}

/**
 * Exported: computed here, per request, from the caller's route params. A teacup that
 * `@needs('balance')` gets this result; it never sees the ledger.
 */
@Step({ provides: 'balance', needs: ['ledger'], export: true })
class BalanceStep {
  run(ctx: { ledger: Ledger; params: { customer?: string } }) {
    const customer = ctx.params.customer ?? '';
    const due = ctx.ledger
      .invoices(customer)
      .filter((invoice) => !invoice.paid)
      .reduce((sum, invoice) => sum + invoice.amount, 0);

    return { balance: { customer, due } };
  }
}

@Route('/billing')
class BillingController {
  @Get('/invoices/:customer', { export: true })
  list(@needs('ledger') ledger: Ledger, @param('customer') customer: string) {
    return { customer, invoices: ledger.invoices(customer) };
  }

  @Post('/invoices/:customer', { export: true })
  create(@needs('ledger') ledger: Ledger, @param('customer') customer: string, @body() data: { amount?: unknown }) {
    const amount = Number(data?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(422, 'amount must be a positive number');

    return ledger.add(customer, amount);
  }
}

@Module({ mountpoint: '/', providers: [LedgerProvider], steps: [BalanceStep], controllers: [BillingController] })
class BillingModule {}

/** The secret every teacup must present. Set MESH_SECRET outside a demo. */
export const MESH_SECRET = process.env.MESH_SECRET ?? 'demo-secret';

export const billing = createApp({ modules: [BillingModule], experimental: true, mesh: { secret: MESH_SECRET } });

if (require.main === module) {
  billing.listen(Number(process.env.BILLING_PORT ?? 3401)).then((server) => {
    const { port } = server.address() as { port: number };
    // The test reads this line to learn the port.
    console.log(`billing (teapot) on http://127.0.0.1:${port}`);
  });
}

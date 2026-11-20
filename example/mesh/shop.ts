// The teacup: the shop. It serves its own checkout route, which `@needs('balance')` exactly as it
// would a local step, and it serves billing's exported routes as if they were its own. Nothing in
// the controller says where `balance` lives; only the mesh config does.
//
//   npx tsx example/mesh/billing.ts      # start the teapot first: checkout needs `balance` at boot
//   npx tsx example/mesh/shop.ts         # on :3400, or SHOP_PORT; BILLING_URL points at the teapot
//
// Mesh is alpha and behind `experimental: true`. See example/README.md for the walkthrough.
import { createApp, Route, Get, Module, needs, MESH_CONTROL_PATH } from '../../src/index';

interface Balance {
  customer: string;
  due: number;
}

@Route('/shop')
class CheckoutController {
  @Get('/checkout/:customer')
  checkout(@needs('balance') balance: Balance) {
    return { customer: balance.customer, due: balance.due, canCheckout: balance.due === 0 };
  }
}

@Module({ mountpoint: '/', controllers: [CheckoutController] })
class ShopModule {}

/**
 * `billingUrl` is the teapot's control channel. `ws://` is fine on loopback; to another machine use
 * `wss://`, or `createApp` refuses (mesh.allowInsecure exists for networks that already encrypt).
 */
export function createShop(billingUrl: string, secret = process.env.MESH_SECRET ?? 'demo-secret') {
  return createApp({
    modules: [ShopModule],
    experimental: true,
    mesh: {
      teapots: [{ url: billingUrl, secret }],
      // Quick retries so the demo recovers in about a second after billing comes back.
      reconnect: { initialDelayMs: 100, maxDelayMs: 1_000 },
      bootTimeoutMs: 5_000,
    },
  });
}

if (require.main === module) {
  const billingUrl = process.env.BILLING_URL ?? `ws://127.0.0.1:3401${MESH_CONTROL_PATH}`;

  createShop(billingUrl)
    .listen(Number(process.env.SHOP_PORT ?? 3400))
    .then((server) => {
      const { port } = server.address() as { port: number };
      console.log(`shop (teacup) on http://127.0.0.1:${port}, billing at ${billingUrl}`);
    });
}

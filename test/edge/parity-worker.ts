// Worker entry that runs the frozen router-parity differential inside workerd: every matcher case
// through the oracle and the live router, and the app.fetch cases, against the same frozen files the
// Node suite uses. The frozen JSON is bundled in, since a worker has no file system. Driven by
// test/edge/run.ts; see test/router-parity/README.md.
import { runDifferential } from '../router-parity/differential';
import { runAppDifferential } from '../router-parity/app-fixture';
import matcherHand from '../router-parity/frozen/matcher-hand.json';
import matcherOwner from '../router-parity/frozen/matcher-owner.json';
import matcherGenerated from '../router-parity/frozen/matcher-generated.json';
import matcherGeneratedV2 from '../router-parity/frozen/matcher-generated-v2.json';
import matcherWs from '../router-parity/frozen/matcher-ws.json';
import appFetch from '../router-parity/frozen/app-fetch.json';
import ownerAppAllow from '../router-parity/frozen/owner-app-allow.json';

const FROZEN: Record<string, unknown> = {
  'matcher-hand': matcherHand,
  'matcher-owner': matcherOwner,
  'matcher-generated': matcherGenerated,
  'matcher-generated-v2': matcherGeneratedV2,
  'matcher-ws': matcherWs,
  'app-fetch': appFetch,
  'owner-app-allow': ownerAppAllow,
};

export default {
  fetch: async (): Promise<Response> => {
    const load = (name: string) => FROZEN[name];
    const matcher = await runDifferential(load);
    const app = await runAppDifferential(load);
    return Response.json({ matcher, app });
  },
};

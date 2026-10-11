// The frozen router-parity differential under the real Deno runtime: every matcher case (hand-picked,
// owner, generated v1/v2, WS) through the oracle and the live router, and the app.fetch cases, all
// against the same frozen files the Node suite uses. See test/router-parity/README.md.
//
// Run with: npm run test:deno
import 'npm:reflect-metadata';
import { assertEquals } from 'jsr:@std/assert';
import { runDifferential } from '../router-parity/differential.ts';
import { runAppDifferential } from '../router-parity/app-fixture.ts';

const load = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`../router-parity/frozen/${name}.json`, import.meta.url)));

Deno.test('router parity on Deno: frozen matcher differential, oracle and live', async () => {
  const report = await runDifferential(load);
  assertEquals(report.mismatches, []);
  assertEquals(report.sets.length, 5);
});

Deno.test('router parity on Deno: app.fetch cases', async () => {
  const report = await runAppDifferential(load);
  assertEquals(report.mismatches, []);
});

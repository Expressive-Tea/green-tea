// The frozen router-parity differential under the real Bun runtime: every matcher case (hand-picked,
// owner, generated v1/v2, WS) through the oracle and the live router, and the app.fetch cases, all
// against the same frozen files the Node suite uses. See test/router-parity/README.md.
//
// Run with: npm run test:bun
import 'reflect-metadata';
import { test, expect } from 'bun:test';
import { runDifferential } from '../router-parity/differential.ts';
import { runAppDifferential } from '../router-parity/app-fixture.ts';

const load = (name: string) => Bun.file(new URL(`../router-parity/frozen/${name}.json`, import.meta.url)).json();

test('router parity on Bun: frozen matcher differential, oracle and live', async () => {
  const report = await runDifferential(load);
  expect(report.mismatches).toEqual([]);
  expect(report.sets.length).toBe(5);
});

test('router parity on Bun: app.fetch cases', async () => {
  const report = await runAppDifferential(load);
  expect(report.mismatches).toEqual([]);
});

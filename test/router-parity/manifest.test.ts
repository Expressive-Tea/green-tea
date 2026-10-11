/**
 * Keeps the retained-test manifest honest: every file it names must exist and every test it names
 * must still be declared there. A rename or deletion during CARD-07 fails here instead of silently
 * shrinking the compatibility baseline. Whether those tests *pass* is `npm test` and the runtime
 * suites' job; this only proves they are still the tests the manifest says they are.
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { PINNED_REVISION } from './frozen';

interface Entry {
  file: string;
  scope?: 'file' | 'tests';
  tests?: string[];
}

const ROOT = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(__dirname, 'manifest.json'), 'utf8')) as {
  revision: string;
  retained: Entry[];
  runtimeSmoke: Entry[];
  supplementary: { retained: Entry[] };
  frozenFixtures: { oracle: string; readme: string };
};

const entries: Entry[] = [...manifest.retained, ...manifest.runtimeSmoke, ...manifest.supplementary.retained];

describe('router parity: retained-test manifest', () => {
  it('is pinned to the same revision as the frozen fixtures', () => {
    expect(manifest.revision).toBe(PINNED_REVISION);
  });

  for (const entry of entries) {
    it(`${entry.file} exists and declares every named test`, () => {
      const path = join(ROOT, entry.file);
      expect(existsSync(path), `${entry.file} is missing`).toBe(true);
      const source = readFileSync(path, 'utf8');

      for (const name of entry.tests ?? []) {
        for (const part of name.split(' > ')) expect(source, `${entry.file}: '${name}'`).toContain(part);
      }
    });
  }

  it('names an oracle and a README that exist', () => {
    for (const file of [manifest.frozenFixtures.oracle, manifest.frozenFixtures.readme])
      expect(existsSync(join(ROOT, file)), file).toBe(true);
  });

  it('the oracle is not imported from src/', () => {
    // A frozen oracle the product can reach is no longer frozen: someone will "fix" it.
    const files = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.ts'),
    );
    const hits = files.filter((f) => readFileSync(join(ROOT, 'src', f), 'utf8').includes('router-parity'));
    expect(hits).toEqual([]);
  });
});

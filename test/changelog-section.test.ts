import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// `scripts/changelog-section.mjs` writes the body of every GitHub release. It is the only place where
// a mistake is invisible until it is already published, so its boundaries are pinned here rather than
// checked by eye at release time.
const SCRIPT = resolve(process.cwd(), 'scripts/changelog-section.mjs');
const section = (version: string, tag?: string): string =>
  execFileSync('node', [SCRIPT, version, ...(tag ? [tag] : [])], { encoding: 'utf8' });

const changelog = readFileSync(resolve(process.cwd(), 'CHANGELOG.md'), 'utf8');
const released = [...changelog.matchAll(/^## \[(\d[^\]]*)\]/gm)].map(([, v]) => v);

describe('changelog section extraction', () => {
  it('finds every released version', () => {
    expect(released.length).toBeGreaterThan(0);
    for (const version of released) {
      expect(section(version).trim(), version).not.toBe('');
    }
  });

  it('stops at the next version, so a section never carries the one below it', () => {
    for (const version of released) {
      expect(section(version), version).not.toMatch(/^## \[/m);
    }
  });

  // The oldest section is the one at risk: nothing follows it but the `[label]: url` block that
  // defines the compare links, which belongs to no version and once ended up inside it.
  it('stops at the link-reference block', () => {
    for (const version of released) {
      expect(section(version), version).not.toMatch(/^\[[^\]]+\]:\s+\S/m);
    }
  });

  // A release body resolves relative links against the release page, not the repository, so every
  // link has to be absolute by the time it is published.
  it('rewrites relative links against the tag', () => {
    for (const version of released) {
      const links = [...section(version, `v${version}`).matchAll(/\]\(([^)\s]+)\)/g)].map(([, url]) => url);
      expect(links.filter((url) => !url.startsWith('http')), version).toEqual([]);
    }
  });

  it('fails rather than publishing an empty body for a version it cannot find', () => {
    expect(() => section('0.0.0-nonexistent')).toThrow();
  });
});

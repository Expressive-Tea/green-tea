import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

interface PackageMetadata {
  readonly repository?: {
    readonly type?: string;
    readonly url?: string;
  };
  readonly bugs?: {
    readonly url?: string;
    readonly email?: string;
  };
  readonly homepage?: string;
  readonly author?: string;
}

interface DenoManifest {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly exports?: Record<string, string>;
}

const read = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf8');
const packageJson = JSON.parse(read('package.json')) as PackageMetadata & { version: string; license: string };

// `deno.json` is JSONC and carries comments. Only whole-line `//` comments are stripped, so this
// can never eat a `//` inside a string value — narrower than a general JSONC parser, and enough,
// versus pulling in a dependency to read one config file.
const denoJson = JSON.parse(
  read('deno.json')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n'),
) as DenoManifest;

describe('package publication metadata', () => {
  it('links npm provenance to the public GitHub repository', () => {
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Expressive-Tea/green-tea.git',
    });
  });

  it('links npm consumers to support and documentation', () => {
    expect(packageJson.bugs).toEqual({
      url: 'https://github.com/Expressive-Tea/green-tea/issues',
      email: 'projects@expressive-tea.io',
    });
    expect(packageJson.homepage).toBe('https://green-tea.expressive-tea.io/docs/');
  });

  // A published package whose only contact is a GitHub URL is unreachable to anyone without
  // an account, so the address is pinned here rather than left to drift back out.
  it('gives npm an address to show for the package', () => {
    expect(packageJson.author).toBe('green-tea contributors <projects@expressive-tea.io>');
  });
});

// npm and JSR are published from the same tag but read their identity from different files, so the
// two can drift silently: bump package.json alone and the next release ships one version to npm and
// the previous one to JSR, under the same tag. Nothing else notices, which is why this is here.
describe('JSR manifest agrees with package.json', () => {
  it('publishes the same package at the same version', () => {
    expect(denoJson.name).toBe('@green-tea/core');
    expect(denoJson.version).toBe(packageJson.version);
    expect(denoJson.license).toBe(packageJson.license);
  });

  // A reader following a docs example should not have to care which registry they installed from.
  it('offers the same entry points npm does', () => {
    const npmEntries = Object.keys(JSON.parse(read('package.json')).exports as Record<string, unknown>);
    expect(Object.keys(denoJson.exports ?? {})).toEqual(npmEntries);
  });
});

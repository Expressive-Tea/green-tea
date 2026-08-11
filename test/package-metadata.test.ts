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

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as PackageMetadata;

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

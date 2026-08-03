import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/stage.yml'), 'utf8');

describe('Verdaccio staging workflow', () => {
  it('publishes immutable prereleases only from release branches', () => {
    expect(workflow).toContain("branches: ['release/**']");
    expect(workflow).toContain('npm audit');
    expect(workflow).toContain('npm run prepublishOnly');
    expect(workflow).toContain('scripts/staging-integrity.ts');
    expect(workflow).toContain('npm publish --ignore-scripts');
    expect(workflow).not.toContain('npm unpublish');
  });
});

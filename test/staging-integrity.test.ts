import { describe, expect, it } from 'vitest';

import { decideStagingPublish } from '../scripts/staging-integrity';

describe('decideStagingPublish', () => {
  it('publishes a version that is not in Verdaccio', () => {
    expect(decideStagingPublish('sha512-local')).toBe('publish');
  });

  it('skips an existing version with identical package contents', () => {
    expect(decideStagingPublish('sha512-local', 'sha512-local')).toBe('skip');
  });

  it('rejects an existing version with different package contents', () => {
    expect(() => decideStagingPublish('sha512-local', 'sha512-other')).toThrow(
      'Version already exists in Verdaccio with different contents',
    );
  });
});

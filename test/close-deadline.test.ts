import { describe, expect, it, vi } from 'vitest';
import { closeWithDeadline } from '../src/http/shutdown';

describe('closeWithDeadline', () => {
  it('treats a graceful close that throws synchronously like one that rejects (GitHub #47)', async () => {
    const force = vi.fn();
    const onTimeout = vi.fn();
    const graceful = (): Promise<void> => {
      throw new Error('sync boom');
    };

    await expect(closeWithDeadline(graceful, force, 20, onTimeout)).resolves.toBeUndefined();

    // Past the deadline: a settled close must not leave its timer behind to force anything later.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onTimeout).not.toHaveBeenCalled();
    expect(force).not.toHaveBeenCalled();
  });
});

/**
 * Measures how much of a corpus exercises sibling branches, so "the generator covers backtracking"
 * is a number rather than a hope. Method-agnostic: a tree is walked by path before a method is
 * chosen, so any declaration that shares the walk counts.
 *
 * - sibling hit: two declarations both match the request's leading segments through a segment
 *   where their patterns differ — the lookup has two branches to choose between at that point.
 * - backtrack: a sibling hit where at least one of those declarations then fails to match the
 *   whole path — a branch the lookup walks into and has to leave.
 */
import { compilePattern, normalizeRequestPath, type CompiledSegment } from './oracle';
import type { Scenario } from './matcher';

function segmentMatches(segment: CompiledSegment, value: string): boolean {
  if (segment.kind === 'static') return segment.value === value;
  if (segment.kind === 'catchAll') return true;
  const decoded = value.includes('%') ? decodeURIComponent(value) : value;
  return !segment.constraint || segment.constraint.test(decoded);
}

/** Leading segments matched, and whether the whole path matched. */
function walk(pattern: string, segs: string[]): { depth: number; full: boolean } {
  const { segments } = compilePattern(pattern);
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].kind === 'catchAll') return { depth: segments.length, full: true };
    if (i >= segs.length || !segmentMatches(segments[i], segs[i])) return { depth: i, full: false };
  }
  return { depth: segments.length, full: segments.length === segs.length };
}

const sameSegment = (a: CompiledSegment, b: CompiledSegment): boolean =>
  JSON.stringify({ ...a, constraint: undefined }) === JSON.stringify({ ...b, constraint: undefined });

export interface BranchStats {
  requests: number;
  validPaths: number;
  siblingHits: number;
  backtracks: number;
  siblingShare: string;
  backtrackShare: string;
}

export function branchStats(scenarios: Scenario[]): BranchStats {
  let requests = 0;
  let validPaths = 0;
  let siblingHits = 0;
  let backtracks = 0;

  for (const scenario of scenarios) {
    const patterns = [...new Set(scenario.declarations.map((d) => d.pattern))];

    for (const { raw } of scenario.requests) {
      requests++;
      let path: string;
      try {
        path = normalizeRequestPath(raw);
      } catch {
        continue;
      }
      validPaths++;

      const segs = path.split('/').filter(Boolean);
      const walks = patterns.map((pattern) => ({ segments: compilePattern(pattern).segments, ...walk(pattern, segs) }));
      let sibling = false;
      let backtrack = false;

      for (let i = 0; i < walks.length; i++) {
        for (let j = i + 1; j < walks.length; j++) {
          const [a, b] = [walks[i], walks[j]];
          const shared = Math.min(a.depth, b.depth, a.segments.length, b.segments.length);
          const diverge = Array.from({ length: shared }, (_, d) => d).find(
            (d) => !sameSegment(a.segments[d], b.segments[d]),
          );
          if (diverge === undefined) continue;
          sibling = true;
          if (!a.full || !b.full) backtrack = true;
        }
      }

      if (sibling) siblingHits++;
      if (backtrack) backtracks++;
    }
  }

  const pct = (n: number) => `${((n / requests) * 100).toFixed(1)}%`;
  return {
    requests,
    validPaths,
    siblingHits,
    backtracks,
    siblingShare: pct(siblingHits),
    backtrackShare: pct(backtracks),
  };
}

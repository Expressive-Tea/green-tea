#!/usr/bin/env node
// Cognitive-complexity gate. Fails (exit 1) if any named function in src/ exceeds
// the threshold, per cognitive-complexity-ts. Cyclomatic complexity is intentionally
// NOT gated here — its `??`-chain false positives make it advisory only (npm run complexity:cyclomatic).
import { execSync } from 'node:child_process';

const THRESHOLD = Number(process.env.COMPLEXITY_MAX ?? 25);

let raw = '';
try {
  raw = execSync('npx ccts-json src', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
  raw = error.stdout?.toString() ?? '';
}

if (!raw.trim()) {
  console.error('check-complexity: no output from ccts-json');
  process.exit(2);
}

const offenders = [];
function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (node.kind === 'function' && node.name && node.score > THRESHOLD) {
    offenders.push({ score: node.score, name: node.name });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'inner' && Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') walk(value);
  }
}
walk(JSON.parse(raw));

if (offenders.length) {
  offenders.sort((a, b) => b.score - a.score);
  console.error(`\n✖ cognitive complexity: ${offenders.length} function(s) over ${THRESHOLD}\n`);
  for (const o of offenders) console.error(`  ${String(o.score).padStart(4)}  ${o.name}`);
  console.error('\nExtract helpers to bring them under the threshold (or raise COMPLEXITY_MAX).\n');
  process.exit(1);
}

console.log(`✓ cognitive complexity: every function ≤ ${THRESHOLD}`);

#!/usr/bin/env node
// Prints one version's section of CHANGELOG.md, for a GitHub release body.
//
// Reads the current file rather than the tag's copy on purpose: the changelog is the record, so a
// correction to an old entry should reach the release that describes it.
//
// Usage: node scripts/changelog-section.mjs <version> [tag]
// The optional tag makes relative links absolute — a release body resolves them against the release
// page, not the repository, and pinning to the tag keeps the link on the file as that version had it.
import { readFileSync } from 'node:fs';

const REPO = 'Expressive-Tea/green-tea';
const [version, tag] = process.argv.slice(2);
if (!version) {
  console.error('usage: changelog-section.mjs <version> [tag]');
  process.exit(2);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split('\n');
const isHeading = (l) => l.startsWith('## [');
// The `[label]: url` block at the bottom of the file belongs to no section. Without this the last
// section swallows it, since nothing else comes after.
const isLinkRef = (l) => /^\[[^\]]+\]:\s+\S/.test(l);

const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`no section for ${version}. Headings in CHANGELOG.md:\n${lines.filter(isHeading).join('\n')}`);
  process.exit(1);
}
const rest = lines.slice(start + 1);
const stop = rest.findIndex((l) => isHeading(l) || isLinkRef(l));
const body = (stop === -1 ? rest : rest.slice(0, stop)).join('\n').trim();

const absolute = tag
  ? body.replace(/\]\(\.\/([^)\s]+)\)/g, `](https://github.com/${REPO}/blob/${tag}/$1)`)
  : body;

console.log(absolute);

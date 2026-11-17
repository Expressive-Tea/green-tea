# AGENTS.md

Guidance for AI coding assistants working in this repository. Claude Code, Codex, Cursor and anything else that reads this file.

If you are an assistant: a person reads every line of what you produce before it lands, and the person submitting it signs off on it. Make that reading worth their time — leave the reasoning visible, don't quietly widen the scope you were asked for, and say what you were unsure about instead of smoothing over it. The "Working with AI assistance" section of `CONTRIBUTING.md` applies to your output.

## What this is

`@green-tea/core` — a type-safe HTTP framework where the API is a dependency graph rather than a middleware chain. You declare what each step needs and provides; the framework computes execution order, fails at boot if something is missing, and can print the whole pipeline. Runs on Node, Deno, Bun and the edge from one codebase.

**Hard constraint: one runtime dependency.** `reflect-metadata`, and nothing else. `busboy` and `ws` are peer dependencies. Anything that would add a third belongs in a plugin, not in core.

## Commands

```bash
npm run lint          # eslint
npm run format:check  # prettier, src/**/*.ts only
npm run typecheck     # must be clean; includes the compile-time-guarantee type test
npm test              # vitest
npm run build         # tsup
npm run complexity:check

npm run test:deno     # the other runtimes are NOT covered by `npm test`
npm run test:bun
npm run test:edge
```

Run the first four before proposing anything as finished. The runtime suites stay separate commands on purpose — a change to shared code that passes `npm test` may still be broken on Deno or Bun — but they are no longer optional: CI runs all three on every push and each one gates a merge. Run them yourself for anything touching `src/http/`, the adapters, or `src/mesh/`, rather than finding out from CI.

## Two forges

Development lives on GitHub: `develop`, feature branches, pull requests, CI and new issues. A
private Gitea instance keeps only `main` and release tags, pushed there by hand, so a release can
be staged on the internal Verdaccio before it goes public. Issues opened on Gitea before
2026-11-17 stay there until they close; new ones go to GitHub.

```
feature/* → develop → main                     (GitHub, pull requests)
                       │
              v* tag ──┼── GitHub: [release.yml] → npm + JSR
                       └── Gitea, pushed by hand when staging: [stage.yml] → Verdaccio
```

- **`develop`** — active development, and the base of every pull request, outside contributions included.
- **`main`** — released code, advanced only by fast-forward from `develop`.
- **Gitea `main` and tags** — a staging copy. Nothing is developed there. A `v*` tag pushed there publishes to Verdaccio, never to a public registry.

Remotes: `origin` is GitHub, `gitea` is the Gitea instance.

## Procedure

**Promotions are fast-forward-only.** `main` becomes an exact copy of `develop` and no commit is ever born on `main`. This is not a preference: merge-style promotions created seven of the ten commits of drift that had to be cleaned up in August 2026, because each one lived on `main` and never travelled back. Release boundaries are marked by `v*` tags, not by promotion commits.

**Only `hotfix/*` can still cause real drift**, since it branches from and returns to `main`. That case genuinely needs a back-merge; nothing else does.

GitHub's merge button cannot promote: merge, squash and rebase all write new commits on `main`,
which is the drift this section exists to prevent. Promote with a plain push instead. Git refuses
it unless it fast-forwards, so it cannot rewrite `main` either:

```bash
git fetch origin && git push origin origin/develop:main
```

**Delete the branch when the work lands.** Both sides, as the last step of merging rather than a chore left for later:

```bash
git branch -d <branch> && git push origin --delete <branch>
```

On 2026-09-22 this repository carried 36 branches on Gitea and 29 locally, every one but a single stale docs branch already merged into `develop`, some of them since July. At that size the branch list stops describing the work in flight and becomes something a release has to audit commit by commit — which is both when it costs the most and when nobody has the patience for it. `git branch -r --merged origin/develop` is the check. A branch whose commits were rebased on the way in will not appear there even though its content did land, so confirm that case by content (`git diff <branch> develop -- <file>`) rather than by the flag. Never `develop`, `main`, or a `release/*` that has not shipped yet.

**Diagnosing "this branch is ahead of main".** Usually it is pre-rebase duplication, not unmerged work: the same content under different SHAs, because contributions are rebased on their way into `develop`. Confirm before acting:

```bash
git diff <branch> <main> -- <suspect file>   # empty means the content is already in main
```

Merging such a branch to "recover" the commits duplicates the work and drags stale history along.

**External contributions** are pull requests against `develop`, reviewed and merged like any other.
Merge rather than rebase, so the contributor's commits reach `main` under their own name and hash.

## Releasing

**Close the `CHANGELOG` section as the step immediately before the tag, never earlier.** A version
heading with a date is a claim that the release exists. Until the tag is pushed and the registries
have it, that claim is false — and a `[26.8.0-beta.1] - 2026-08-17` sitting above work that shipped
nowhere is worse than no heading at all, because the next reader believes it.

This is not hypothetical: the beta.1 section was written the day the version was *decided*, the
release slipped, and a day of further work landed underneath it as `[Unreleased]`. The file then said
two contradictory things — that beta.1 was released, and that everything in it was not.

So the order is: everything merged and promoted → **close the section with the release date** → tag →
registries. Until that step, work accumulates under `[Unreleased]`, however certain the next version
number feels.

Bumping `package.json` and `deno.json` ahead of the tag is fine and necessary — those say what the
*next* publish will be called, and the docs repo's `verify:release` compares the tag against them.
A version number is a plan; a changelog heading is a receipt.

**Stage on Verdaccio first when a release warrants it.** Pushing a `v*` tag to GitHub publishes it
to npm and JSR, and JSR never gives a version number back. Pushing the same tag to Gitea first runs
the real publish path against Verdaccio, where a mistake costs only a re-tag:

```bash
git push gitea main v<version>   # optional: Gitea → Verdaccio, reversible
git push origin v<version>       # GitHub → npm + JSR, permanent on JSR
```

The split exists because a mistake caught on Verdaccio costs a re-tag, and the same mistake
caught on JSR costs the version number forever.

**After a beta release, move the channel tag by hand.** A publish sets exactly one dist-tag, and it
is the only npm write the release workflow can make — Trusted Publishing's OIDC exchange lives inside
`npm publish`, so the token it hands back is rejected by `npm dist-tag` (`E401`, learned the hard way
on `v26.8.0-beta.1`). While there is no stable release the publish spends that one tag on `latest`,
since that is what a bare `npm install @green-tea/core` resolves to, and the workflow prints the
command for the rest:

```bash
npm dist-tag add @green-tea/core@<version> beta
```

Once a stable version exists this stops being a chore: `latest` belongs to the stable release, the
publish gives a beta its channel tag directly, and there is nothing left to move.

## CI

The audit gate is scoped, not severity-filtered: `npm audit --omit=dev` blocks, everything else is `continue-on-error`. A critical in the test runner reaches nobody; a high in `reflect-metadata` reaches everyone. It runs *after* the code gates, because an advisory published by a third party must never decide whether a contributor sees their own lint and typecheck output.

**The forges disagree about where workflows come from.** GitHub reads `pull_request` workflows from the base branch, so a workflow fix cannot validate itself and must reach the base before it gates anything. Gitea reads from the head. Likewise, `continue-on-error` steps report as `success` on GitHub, hiding the advisory in the log, but as `failure` with the job still green on Gitea.

GitHub does not run workflows on fork pull requests until a maintainer approves them. A contributor's first push may sit with no checks at all.

## Conventions

- Conventional Commits, focused on the *why*. Every commit signed off (`git commit -s`) — the project uses a DCO, and unsigned commits are rejected. No AI co-authoring attribution.
- Comments carry reasoning the code cannot show. When editing a block, keep them; if one explains an ordering or a version floor, it is load-bearing.
- A new option or method on a public interface has to change `src/app/types.ts` too. An implementation that grows a parameter alone is unreachable for anyone consuming the package.
- Behaviour that differs between runtimes must be explicit. An "unavailable here" is fine; silently accepting an option that does nothing is a bug.
- New public API needs a note in `README.md` **and a companion pull request to the documentation repository**, [green-tea-docs](https://github.com/Expressive-Tea/green-tea-docs) — separate, because a pull request cannot span two repositories. Since the split, nothing here imports those pages and nothing fails when they disagree with this code — the CI job that used to build them is gone. That makes this the only thing standing between a rename and a guide that quietly documents a version nobody can install.

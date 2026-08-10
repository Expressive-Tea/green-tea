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

Run the first four before proposing anything as finished. The runtime suites are separate on purpose — a change to shared code that passes `npm test` may still be broken on Deno or Bun.

## Two forges

Development lives on a private Gitea instance. GitHub is a downstream mirror that receives `main` and release tags, nothing else.

```
feature/* → develop → main → [promote.yml] → GitHub main
                ↑                                  ↓
           lead dev                          GitHub contrib ← external PRs
```

- **Gitea `develop`** — active development.
- **Gitea `main`** — staging. Merging here publishes nothing; only a `v*` tag publishes.
- **GitHub `main`** — production mirror. No human touches it. Protected against force-push and deletion, with no review requirement, because `promote.yml` pushes to it directly and a review rule would block that.
- **`contrib`** — exists on *both* forges. Where outside contributions land.

`develop` and `main` on Gitea have direct push disabled with an empty whitelist, so nobody can push to them, admins included. Advance them by opening a PR and merging it.

## Procedure

**Promotions are fast-forward-only.** `develop → main` merges with Gitea's fast-forward-only style, so `main` becomes an exact copy of `develop` and no commit is ever born on `main`. This is not a preference: merge-style promotions created seven of the ten commits of drift that had to be cleaned up in August 2026, because each one lived on `main` and never travelled back. Release boundaries are marked by `v*` tags, not by promotion commits.

**Only `hotfix/*` can still cause real drift**, since it branches from and returns to `main`. That case genuinely needs a back-merge; nothing else does.

**Diagnosing "this branch is ahead of main".** Usually it is pre-rebase duplication, not unmerged work: the same content under different SHAs, because contributions are rebased on their way into `develop`. Confirm before acting:

```bash
git diff <branch> <main> -- <suspect file>   # empty means the content is already in main
```

Merging such a branch to "recover" the commits duplicates the work and drags stale history along.

**External contributions.** They arrive on GitHub `contrib`. Merge the pull request there, mirror that branch to Gitea, then open a `contrib → develop` pull request and merge it. Merge rather than rebase: because promotions are fast-forward-only, `develop` and `main` are the same commit, so there is no main-only history for a merge to drag in. Rebasing would rewrite the contributor's SHAs for no gain and push `contrib` out of `main`'s ancestry, which then costs a force-push at reset time. Merging keeps their commits reaching `main` under their own name and hash.

The exception is a `hotfix/*`, which lands on `main` without passing through `develop` and leaves the two out of step. Back-merge before taking a contribution through, or rebase that one and accept the force-push. If you do rebase, take the commit range from the pull request itself and never "everything since main": if a second contributor branched from `contrib` after the first one merged, the broad range sweeps up work that isn't theirs.

**After every promotion, reset *both* `contrib` branches to `main`.** GitHub's is where external work lands; Gitea's is its mirror, and the easy one to forget because nothing there refuses the push. Normally this is an ordinary fast-forward, since `contrib` is already inside `main`'s history. It only needs a force-push when SHAs were rewritten on the way in — and GitHub then refuses it even for admins, so that branch's protection has to be lifted and restored around the reset.

A conflict against unreleased `develop` work can never be delegated to an outside contributor — they cannot see the code they are conflicting with. Those are always the maintainer's to resolve.

## CI

The audit gate is scoped, not severity-filtered: `npm audit --omit=dev` blocks, everything else is `continue-on-error`. A critical in the test runner reaches nobody; a high in `reflect-metadata` reaches everyone. It runs *after* the code gates, because an advisory published by a third party must never decide whether a contributor sees their own lint and typecheck output.

**The forges disagree about where workflows come from.** GitHub reads `pull_request` workflows from the base branch, so a workflow fix cannot validate itself and must reach the base before it gates anything. Gitea reads from the head. Likewise, `continue-on-error` steps report as `success` on GitHub, hiding the advisory in the log, but as `failure` with the job still green on Gitea.

GitHub does not run workflows on fork pull requests until a maintainer approves them. A contributor's first push may sit with no checks at all.

## Conventions

- Conventional Commits, focused on the *why*. Every commit signed off (`git commit -s`) — the project uses a DCO, and unsigned commits are rejected. No AI co-authoring attribution.
- Comments carry reasoning the code cannot show. When editing a block, keep them; if one explains an ordering or a version floor, it is load-bearing.
- A new option or method on a public interface has to change `src/app/types.ts` too. An implementation that grows a parameter alone is unreachable for anyone consuming the package.
- Behaviour that differs between runtimes must be explicit. An "unavailable here" is fine; silently accepting an option that does nothing is a bug.
- New public API needs a note in `README.md`.

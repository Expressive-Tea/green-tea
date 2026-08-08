# Contributing to green-tea

Thanks for your interest. green-tea is open source, but not anyone can push directly — contributions land through reviewed pull/merge requests with a **DCO sign-off**.

## Where to send your changes

Development happens on a private Gitea instance. The GitHub repository is a downstream mirror: it receives `main` and release tags, and nothing else. Which branch you target depends on where you are.

**From GitHub, if you are an outside contributor:** open your pull request against **`contrib`**. Not `main`. `main` on GitHub is a mirror of released code, and merging into it puts the two forges out of sync and breaks the next release push. A maintainer reviews on `contrib` and then carries your commits upstream into Gitea's `develop`, with your authorship and your sign-off intact.

**From Gitea, if you have access:** follow the branch model below.

### Worked example

```bash
# fork Expressive-Tea/green-tea on GitHub, then
git clone git@github.com:<you>/green-tea.git
cd green-tea
git remote add upstream https://github.com/Expressive-Tea/green-tea.git
git fetch upstream

# branch from contrib, not from main
git checkout -b fix/close-timeout upstream/contrib

# ... make the change, add a test ...

git commit -s -m "fix: add a timeout to app.close()"
git push origin fix/close-timeout
```

Then open the pull request with **`contrib`** as the base branch.

`contrib` tracks released code, so it is reset to `main` after each release. If your branch has been open across one, rebase onto the new `contrib` before pushing again.

## Developer Certificate of Origin (DCO)

We use the [Developer Certificate of Origin](./DCO) instead of a CLA. It's a lightweight, per-commit affirmation that you have the right to submit your work under the project's license. No copyright assignment, no paperwork.

**Every commit must be signed off.** Add the `-s` flag:

```bash
git commit -s -m "feat: add the thing"
```

This appends a trailer to your commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must match your real `git config user.name` / `user.email`. Commits without a valid `Signed-off-by` line are rejected.

To sign off a range you forgot to sign:

```bash
git rebase --signoff <base>
```

Or, for the commit you just made:

```bash
git commit --amend -s
git push --force-with-lease
```

## Branch model (GitFlow)

- `main` — production-ready, protected. No direct pushes.
- `develop` — active development, protected. Feature branches merge here.
- `feature/<name>` — branch from `develop`.
- `hotfix/<name>` — branch from `main`.
- `release/<version>` — release stabilization.
- `contrib` — GitHub only. Where outside contributions land before a maintainer moves them to `develop`.

`main` and `develop` are protected: they require a reviewed MR and signed-off commits. (Branch protection is configured on the git server, not in this repo.)

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Focus the message on the *why*. Do not add AI co-authoring attribution.

## Before you open a pull request

Run what CI runs:

```bash
npm run lint
npm run format:check
npm run typecheck # must be clean — this includes the compile-time-guarantee type test
npm test          # all tests must pass
```

- Write tests for new behavior (TDD welcome). We use Vitest.
- Keep runtime dependencies at zero beyond `reflect-metadata`.
- A new option or method on a public interface has to change that interface too. An implementation that grows a parameter without `src/app/types.ts` growing it as well is unreachable for anyone consuming the package.
- New public API needs a doc note in `README.md`.
- If your change only works on one runtime, say so in the pull request. green-tea runs on Node, Deno, Bun and the edge, and behavior that quietly differs between them is treated as a bug — an explicit "not available here" is fine, silence is not.

On GitHub, workflows do not run on pull requests from forks until a maintainer approves them, so your first push may sit without any checks for a while. That is not a rejection.

## Reporting issues

Open an issue with a minimal reproduction: green-tea version, runtime and version, and the smallest module/route that shows the problem.

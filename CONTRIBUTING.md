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

## Working with AI assistance

Use one if it helps. There is no permission to ask for and nothing to declare.

What we do ask is that you read what it hands you before it becomes a pull request. Every line that lands here is reviewed by a person, by hand, and usually that person is one person. A diff its own author hasn't read moves that work onto them, and turns review into proofreading — which is the thing review is worst at.

So go through the diff the way you would go through a stranger's, because that is what it is. If you can't say why a line is there, it isn't ready to send. That's the whole of it.

**What assistants tend to get wrong here in particular** — worth checking before you push:

- They add dependencies. Core has one runtime dependency, and that is a design constraint rather than an oversight.
- They write for Node and assume the rest follows. It doesn't — green-tea also runs on Deno, Bun and the edge, and `npm test` does not cover them.
- They delete comments they read as redundant. In this codebase a comment usually carries reasoning the code can't show on its own.
- They skip the test.

**Where you're unsure, say so** — not as a disclosure, as a pointer. "I'm not confident about the Deno path here" tells a reviewer where to spend their attention, and that is worth more to them than a pull request that merely looks clean.

None of this changes the sign-off. `Signed-off-by` says you have the right to submit the work under this project's license, and that stays true however the text was produced.

If your assistant reads repository instructions, `AGENTS.md` has the conventions and the architecture notes.

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
npm run complexity:check
```

- Write tests for new behavior (TDD welcome). We use Vitest.
- `complexity:check` caps the cognitive complexity of every function in `src/`. What it measures is how much you have to hold in your head to follow a function from top to bottom, and it charges nesting more heavily than branching: a condition inside a closure inside a function costs several times what the same condition costs at the top level. Going over the threshold is not a verdict on your code — it means one function has grown to ask too much of whoever reads it next. The fix is nearly always to lift a nested closure out to module scope, where its branches are charged once instead of three times over. Raising `COMPLEXITY_MAX` is not the fix, even though the script suggests it.
- Keep runtime dependencies at zero beyond `reflect-metadata`.
- A new option or method on a public interface has to change that interface too. An implementation that grows a parameter without `src/app/types.ts` growing it as well is unreachable for anyone consuming the package.
- New public API needs a doc note in `README.md`.
- If your change only works on one runtime, say so in the pull request. green-tea runs on Node, Deno, Bun and the edge, and behavior that quietly differs between them is treated as a bug — an explicit "not available here" is fine, silence is not.

On GitHub, workflows do not run on pull requests from forks until a maintainer approves them, so your first push may sit without any checks for a while. That is not a rejection.

## Reporting issues

Open an issue with a minimal reproduction: green-tea version, runtime and version, and the smallest module/route that shows the problem.

# Contributing to green-tea

Thanks for your interest. green-tea is open source, but not anyone can push directly — contributions land through reviewed pull/merge requests with a **DCO sign-off**.

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

## Branch model (GitFlow)

- `main` — production-ready, protected. No direct pushes.
- `develop` — active development, protected. Feature branches merge here.
- `feature/<name>` — branch from `develop`.
- `hotfix/<name>` — branch from `main`.
- `release/<version>` — release stabilization.

`main` and `develop` are protected: they require a reviewed MR and signed-off commits. (Branch protection is configured on the git server, not in this repo.)

## Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Focus the message on the *why*. Do not add AI co-authoring attribution.

## Before you open an MR

```bash
npm test          # all tests must pass
npm run typecheck # must be clean — this includes the compile-time-guarantee type test
```

- Write tests for new behavior (TDD welcome). We use Vitest.
- Keep runtime dependencies at zero beyond `reflect-metadata`.
- New public API needs a doc note in `README.md`.

## Reporting issues

Open an issue with a minimal reproduction: green-tea version, Node version, and the smallest module/route that shows the problem.

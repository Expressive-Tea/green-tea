> **Base branch:** on GitHub this must target `contrib`, not `main`. You can still change it above, before you submit — and [here is why](https://github.com/Expressive-Tea/green-tea/blob/main/CONTRIBUTING.md#where-to-send-your-changes). Delete this line once the base is right.

## What this changes

<!-- A sentence or two, on the why rather than the what. -->

Closes #

## Checklist

- [ ] The base branch above is `contrib`
- [ ] Commits are signed off (`git commit -s`)
- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run complexity:check` and `npm run build` pass locally
- [ ] New behavior has a test
- [ ] A new public option or method is also declared in `src/app/types.ts`, and noted in `README.md`
- [ ] Behavior is the same on Node, Deno and Bun — or the difference is deliberate, and said out loud here

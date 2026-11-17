## What this changes

<!-- A sentence or two, on the why rather than the what. -->

Closes #

## Checklist

- [ ] The base branch above is `develop`
- [ ] Commits are signed off (`git commit -s`)
- [ ] `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run complexity:check` and `npm run build` pass locally
- [ ] The runtime suites this change touches pass locally (`npm run test:deno`, `test:bun`, `test:edge`, or `test:all`), and they are named here
- [ ] New behavior has a test
- [ ] A new public option or method is also declared in `src/app/types.ts`, and noted in `README.md`
- [ ] Behavior is the same on Node, Deno and Bun — or the difference is deliberate, and said out loud here

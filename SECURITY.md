# Security Policy

## Reporting a vulnerability

Email **security@expressive-tea.io**. Please do not open a public issue for something
exploitable — an issue is world-readable from the moment you press the button, and that is
the one thing a security report cannot be.

Include whatever you have: the version, the runtime, and the smallest app that shows it.
A route, a module and a request is usually enough. If you have a working exploit, send it;
if you only have a suspicion, send that instead of sitting on it.

You can also report privately through GitHub's
[security advisory form](https://github.com/Expressive-Tea/green-tea/security/advisories/new),
which reaches the same people.

## What happens next

We will acknowledge your report within 3 working days, and tell you whether we agree it is a
vulnerability within 10. If we do, you get the fix timeline and a heads-up before the advisory
goes public. If we don't, you get the reasoning rather than silence.

We publish a GitHub advisory for anything that affects a released version, and credit you by
the name you ask for. Say so if you would rather not be named.

Green tea is a small project run by a small number of people. We do not run a bug bounty and
have no money to offer you, which we would rather state plainly than leave you to discover.

## Supported versions

While the package is in beta, only the most recent `26.x.y-beta.N` receives fixes. There is no
backport channel yet; when the first stable ships, this section gets the real table.

## Scope

In scope: anything in `src/` that ships in the published package — route matching, the request
pipeline, body parsing and its limits, the security headers and CORS handling, TLS setup, the
WebSocket upgrade path, the mesh wire protocol, static file serving and view rendering.

Out of scope: the benchmarks in `bench/`, the docs site in `website/`, dev-only tooling, and
anything that requires an attacker to already control your application code. Advisories in
build-time dependencies are worth telling us about, but they are not vulnerabilities in
green-tea and we handle them as ordinary dependency updates.

A denial of service that needs no authentication is in scope. Reports that amount to "this
endpoint is slow under load" generally are not — but if you are unsure which one you have,
send it and let us decide.

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

Acknowledgement within **5 working days**. A verdict on whether we agree it is a vulnerability
within **15**. If we agree, you get the fix timeline and a heads-up before the advisory goes
public. If we don't, you get the reasoning rather than silence.

Those numbers are deliberately slower than the 24 to 48 hours you will see quoted elsewhere.
That figure comes from the CERT Guide to Coordinated Vulnerability Disclosure and describes
vendors and coordinators — organizations with someone on rotation. This project is one person.
A number that only holds in a good week is worse than an honest one.

Which is why there is an escape hatch, and you should use it. **If you have no acknowledgement
after 10 working days**, write directly to diego.resendez@expressive-tea.io. If that is also
met with silence, consider yourself released from any embargo and disclose as you see fit. You
will not have done anything wrong: a project that goes quiet on a security report has spent
whatever claim it had on your patience.

## Disclosure window

We ask for **90 days** from your report before public disclosure, or until the fix ships,
whichever comes first. That is the industry default and we are not asking you for more than
anyone else does. If the fix is out in a week, so is the advisory.

If a vulnerability is being actively exploited, the window is however long it takes us to ship,
and we will say so rather than hold you to 90 days while users are being attacked.

We publish a GitHub advisory for anything that affects a released version, and credit you by
the name you ask for. Say so if you would rather not be named.

There is no bug bounty and no money, which we would rather state here than leave you to find
out after the work.

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

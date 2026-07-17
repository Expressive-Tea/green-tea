---
title: The matcha CLI
description: "Scaffold, run, and generate green-tea apps from a single native binary."
---

**matcha** scaffolds green-tea projects, runs them in watch mode, and generates pieces already wired into your graph. It is a native binary — installing the CLI needs no JS runtime, and it only reaches for yours when it runs or type-checks your project.

That is deliberate: green-tea runs on Node, Deno, Bun, and the edge, so its tool shouldn't be bound to one of them.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/Expressive-Tea/matcha/main/install.sh | sh
```

Downloads a checksum-verified prebuilt binary into `~/.local/bin`. Environment variables go on the `sh` side of the pipe:

```bash
curl -fsSL …/install.sh | MATCHA_VERSION=v26.7.0 MATCHA_INSTALL_DIR=/usr/local/bin sh
```

From source, if you have Rust:

```bash
cargo install --git https://github.com/Expressive-Tea/matcha
```

## Scaffold — `matcha new`

```bash
matcha new my-api                                 # Node (the default)
matcha new my-api --runtime deno                  # or deno | bun
matcha new my-api --template-url gh:owner/repo    # any git template
```

The starter is alive on the first run: it serves an `index.html` and streams a rotating zen message over `@Sse('/zen')`. Open the browser and something is already moving — you are editing a working app, not assembling one.

Only the entry point and the config differ between runtimes. The `src/` tree is identical, which is the same portability the framework promises.

## Run — `matcha run`

```bash
matcha run
```

Detects the runtime and starts a watch loop. First match wins:

1. `matcha.toml` — an explicit `runtime = "node" | "deno" | "bun"`
2. `deno.json` / `deno.jsonc` → deno
3. `bun.lockb` / `bun.lock` → bun
4. `package.json` → node

Edge is a deploy target, not a `matcha run` target.

## Generate — `matcha create`

```bash
matcha create controller Users
matcha create step Authenticate
matcha create provider Database
matcha create module Billing
matcha create controller Users --check   # type-check with your runtime afterward
```

Writes the file **and wires it in** — into the right `@Module` array, or into `createApp({ modules })` for a module.

## Extend — `matcha add`

```bash
matcha add sse      # or: stream | buffer
```

Inserts a handler of that shape into your controller.

## How the edits stay safe

`create` and `add` edit your TypeScript with [tree-sitter](https://tree-sitter.github.io), not string splicing or regex. Edits are **idempotent** — running the same command twice doesn't duplicate anything — and they **revert themselves** if the result wouldn't parse. A generator that corrupts your source is worse than no generator.

One case it deliberately refuses: if `modules` is a variable (`modules: MODULES`) rather than an array literal, `create module` won't add a second `modules` key. Duplicate keys parse cleanly, so nothing would fail — it would just silently shadow your value. It tells you instead.

# gh-local-repo-cleaner

A CLI built with [Crust](https://crustjs.com).

Runtime: **bun**. Build output: **binary**.
Change `crust.runtime` and `crust.artifact` in `package.json` to change these choices.

## Development

Install dependencies if you skipped installation or just cloned the project:

```sh
bun install
```

```sh
# Run in dev mode
bun run dev

# Type-check
bun run check:types

# Test the core using temporary repositories
bun test

# Run all quality checks (Biome, Fallow, TypeScript, tests)
bun run check

# Apply safe Biome fixes and formatting
bun run fix

# Build into .crust/
bun run build

# Run the built CLI
bun run start
```

## Code quality

Quality tooling is pinned in dev dependencies. Biome checks formatting, imports
and recommended lint rules for TypeScript and root JSON configuration. Fallow
checks unused files, exports, types, dependencies, unresolved imports and
architecture issues. Tests are explicit Fallow entry points; the CLI is detected
from `package.json`. Generated `.crust/` output and local caches are excluded.
No baseline or blanket suppression is used.

Run `bun run check:biome`, `bun run check:fallow`, or `bun run check:types`
individually when needed. `bun run check` is read-only and fails on findings;
`bun run fix` only applies Biome's safe fixes. GitHub Actions runs quality checks
once on Linux, then tests once per OS (Linux x64 and macOS arm64). Each OS builds
and packages its binary after its tests pass, without rerunning the tests.
The workflow runs for pull requests and pushes to `main`; feature-branch pushes
do not create a second run alongside their PR. New runs cancel older in-progress
runs for the same ref. Hosted CI has not been executed or verified in this session.

## Build and distribution

`bun run build` stages the selected output and npm metadata in `.crust/`:

- `package`: a JavaScript bundle in `.crust/root/` that requires the selected runtime installed.
- `binary`: a standalone executable per platform, with its runtime embedded. Pass `--target host` to `crust build` to build only this machine's target.

Bun is used for build preparation and Bun/Node bundling. Node binaries additionally need Node 26+ and Crust's optional compiler backend; Deno builds need Deno on PATH, with Deno 2.5+ required for experimental runtime-package bundling. Crust does not install or upgrade compilers. See [compiler requirements](https://crustjs.com/docs/guide/build-and-distribution#binary-runtime-version).

`bun run release` publishes the staged packages to npm, but npm is optional. For direct downloads, Homebrew or Scoop, distribute the executable and adjacent assets from `.crust/<platform>/bin/`. Direct binaries need no separately installed JavaScript runtime; the generated npm binary launcher needs Node.js. Crust does not generate installer definitions or publish release archives. See [custom distribution](https://crustjs.com/docs/guide/build-and-distribution#custom-distribution).

The CI build follows the [Crust build and distribution guide](https://crustjs.com/docs/guide/build-and-distribution/):
it pins Bun 1.4.4, runs `bun run build --target host`, checks the standalone
binary with `--help`, then archives the complete platform `bin/` directory so
adjacent assets and executable permissions are preserved. Downloadable workflow
artifacts contain the `.tar.gz`, its SHA-256 checksum and the build manifest.
They are CI artifacts; publishing to npm or GitHub Releases remains a separate action.

## Usage

The CLI still exposes the original greeting scaffold. Repository commands and
move/restore operations are not implemented yet.

```sh
# Run the CLI
gh-local-repo-cleaner world
gh-local-repo-cleaner --greet Hey world
```

## Internal core

The core uses Effect 4 and is independent of Crust commands:

- `src/core/diagnosis.ts`: stable diagnosis shape, reason codes and suggested
  actions. Priority is `UNKNOWN > PROTECTED > DIRTY > SAFE`; reasons are retained.
- `src/core/command.ts`: injectable Git/ghq runner using argument arrays, a default
  30-second timeout and interruption. Raw command output is not included in errors.
- `src/core/inspection.ts`: local checks and sequential batch inspection. Checks
  cover staged/unstaged/untracked files, ignored files, stash, tags, detached HEAD,
  additional worktrees, gitlinks, bare/shallow layouts, upstreams and remote presence.
  Exclusion decisions can be supplied by the caller; configuration loading is pending.
- `src/runtime.ts`: dependency layers connected through the official
  `@crustjs/effect` adapter. `layer("core", CoreLive)` provides the services;
  `handler()` runs an action's Effect with those services and forwards cancellation.
  Layers are built when the handler starts and released after the invocation,
  including failure and interruption. No custom `ManagedRuntime` is needed.

For use from a Crust action:

```ts
import { Crust } from "@crustjs/core";
import { handler } from "@crustjs/effect";
import { inspectRepository } from "./src/core/inspection.ts";
import { coreContext } from "./src/runtime.ts";

const app = new Crust("example").provide(coreContext()).action(
  handler(() => inspectRepository({ path: "/absolute/canonical/repository/path" })),
);
```

For use outside Crust:

```ts
import { Effect } from "effect";
import { inspectRepositories } from "./src/core/inspection.ts";
import { CoreLive } from "./src/runtime.ts";

const results = await Effect.runPromise(
  inspectRepositories([{ path: "/absolute/canonical/repository/path" }]).pipe(
    Effect.provide(CoreLive),
  ),
);
```

This is an initial, read-only implementation. Every live inspection includes
`ONLINE_NOT_VERIFIED` and returns `UNKNOWN`, even when the local checks pass.
The pure aggregator can represent `SAFE`, but this is not authorization to move a
repository. Current remote-ref verification, reflog/unreachable-object analysis,
partial clone/alternates detection, ghq discovery and root-boundary validation,
metadata, configuration and move/restore are pending. No fetch, commit, push or
repository move is performed by this implementation.

Tests run against disposable repositories only; real user repositories and online
remotes have not been used for validation. Integration follows the
[Crust Effect adapter](https://crustjs.com/docs/modules/effect/) and
[Effect 4 service API](https://github.com/Effect-TS/effect/blob/main/migration/services.md).

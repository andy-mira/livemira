# Contributing to LiveMira

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for helping. This page explains how the repository is organized and what a change needs before it is
merged.

## Set up

Node.js ≥ 25.9 (see `.node-version`); npm workspaces.

```sh
npm ci
npm run check   # what CI runs: format, lint, types, API reports, versions, structure, content, WebAssembly, tests
```

Browser probes need Playwright's Chromium and WebKit:

```sh
npm run test:browser
```

Set `LIVEMIRA_BROWSERS=chromium` to run Chromium only, or `LIVEMIRA_WEBKIT_PATH` to point at a WebKit build when the
installed one does not match. Desktop browsers cannot reproduce every phone behavior (in particular the native video
layer of iOS); changes to the camera, the viewport gate, the renderer or media also need a check on a phone.

## Layout and dependencies

- `packages/*` are the engine modules. Dependencies point one way: `contracts` ← algorithm and capture packages ←
  `sdk` (`@livemira/engine`) ← `apps`. `npm run check` rejects reverse, circular or deep imports (into another
  package's `src/`).
- The optional extensions (`tracking-visuals`, `recognition-diagnostics`, `target-quality`) never become dependencies
  of the engine; they use the engine's types only.
- `apps/demo` uses only the public entries of the engine, the extensions and the page shell. If the demo needs
  something internal, the public API has a gap: add the API instead.
- Each package exports through `src/index.ts` only.

## Code

- TypeScript in strict mode, ES modules, erasable syntax only (no `enum`, parameter properties or `namespace`):
  tests run the sources directly with `node --test`. Relative imports end in `.ts`.
- Prettier decides formatting (`npm run format`); ESLint must pass.
- Names: `is`/`has`/`should`/`can` for booleans; physical quantities carry their unit (`timestampUs`, `quietMs`,
  `widthPx`); matrices are named `H_targetFromSource`.
- Comments are in English and explain why, not what. Public API needs TSDoc: purpose, units, errors, lifecycle.
- Every source file starts with:

  ```ts
  /*! Copyright 2026 Andy (@andy-mira)
   * SPDX-License-Identifier: Apache-2.0
   */
  ```

- No new runtime dependencies: the engine bundles nothing from third parties.

## Behavior and algorithms

- Recognition, tracking, matching and geometry are bit-exact today: the same input gives the same bytes. A change that
  alters their output is a behavior change. Explain it in the pull request, show measurements, and add it to
  `CHANGELOG.md`.
- Known defects are marked in code with `// KNOWN-ISSUE:` and are fixed one per change, each with a CHANGELOG entry.
- Do not weaken an assertion to make a test pass.

## Public API

`api/*.api.md` holds the public API of each published module. When you change an export, run `npm run build:types`
and commit the updated report; reviewers read its diff. `npm run check` fails while a report is out of date.

## Versions

The root `package.json` holds the only hand-edited version. Run `npm run version:sync` after changing it; the check
fails when a package, the lock file or `ENGINE_VERSION` disagrees.

## Commits and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) with an imperative English summary, for example
  `fix(media): keep the plane hidden after a decode error`.
- One change per commit, small enough to review and revert on its own.
- Tests and documentation come with the change. User-visible changes go into `CHANGELOG.md`.
- Test output goes to ignored directories (`reports/`, `test-results/`, `logs/`), never into tracked files.
- Tracked files hold no local paths, tool attributions, credentials or development notes; `npm run check` looks.

## License

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as described in
its section 5.

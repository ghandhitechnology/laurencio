# Phase 1: Scaffold

Back-link: [overview](overview.md)

## Goal

A monorepo that installs, typechecks, lints, tests, and builds with one command each, on a clean machine, in CI.

## Changes

- `package.json` (root): bun workspaces over `packages/*`, scripts `check`, `lint`, `test`, `build`, `e2e:*`, `scan:demo`. Pin the bun version with `packageManager`.
- `tsconfig.base.json`: strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, module resolution for bun.
- `biome.json`: formatting and lint rules; no Prettier, no ESLint.
- `.github/workflows/ci.yml`: install with frozen lockfile, check, lint, test, build; matrix ubuntu-latest and macos-latest.
- `packages/{protocol,core,cli,server}/package.json` and `src/index.ts` stubs exporting a version constant.
- `README.md`, `LICENSE`, `.gitignore`, `.editorconfig`.
- `scripts/` directory with a placeholder for the fixture and e2e levers added in phases 3 and 9.

## Data structures

None. This phase only establishes the skeleton.

## Verification

Static: `bun install --frozen-lockfile && bun run check && bun run lint && bun test` passes locally and in CI on both platforms.

Runtime: `bun packages/cli/src/index.ts --version` prints the version; `bun run build` produces dist output for all four packages. Confirm CI is green on the pushed branch.

## Notes

Keep this phase free of product logic. No CI additions beyond check, lint, test, build (the **foundational-thinking** principle: scaffold only what every later phase consumes). Do not add release workflows yet; phase 14 owns them.

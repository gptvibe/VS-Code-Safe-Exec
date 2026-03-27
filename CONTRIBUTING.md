# Contributing

Thanks for helping improve VS Code Safe Exec.

## Prerequisites

- Node.js 20
- npm

Install dependencies with:

```bash
npm ci
```

## Local workflow

Use these commands before you open a pull request:

```bash
npm run check
```

Or run the full sequence step by step:

```bash
npm run lint
npm run typecheck
npm run compile
npm test
npm run coverage
```

What each command does:

- `npm run lint` runs ESLint across the TypeScript source tree and fails on warnings.
- `npm run typecheck` runs the TypeScript compiler in `--noEmit` mode.
- `npm run compile` builds the extension into `out/`.
- `npm test` runs the VS Code extension test suite.
- `npm run coverage` reruns the extension test suite under coverage collection and enforces the repository coverage threshold.

## Quality gates

The CI workflow is intentionally strict:

- Ubuntu runs lint, typecheck, compile, extension tests, and coverage threshold enforcement.
- Ubuntu, Windows, and macOS all run the compiled extension test suite.
- A pull request is expected to keep the coverage gate green.

Coverage is collected from the real extension-host test run, not from a separate unit-test-only path.

## Pull requests

Please keep changes focused and update docs when behavior, commands, CI expectations, or user-facing copy changes.

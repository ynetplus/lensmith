# Lensmith

**Lensmith** is a headless, CLI-first screen-recording and auto-zoom tool for demo and
tutorial video, built to be driven by scripts and AI agents. It re-hosts the reusable,
non-Electron-coupled pieces of [OpenScreen](https://github.com/siddharthvaddem/openscreen)
(MIT, © Siddharth Vaddem) behind a scriptable CLI. See `NOTICE.md` for the full attribution
and reuse map. Lensmith itself is Apache-2.0 (see `LICENSE`).

## Stack

- Node.js + TypeScript (ESM), `commander` for the CLI, `vitest` for tests, `biome` for
  lint and format.
- Native macOS helpers in Swift (ScreenCaptureKit and cursor capture), built into `bin/`.
- Rendering runs OpenScreen's vendored PixiJS + WebCodecs export code in a headless
  Playwright/Chromium page.
- No database, no UI, no hosted service. Lensmith is a stateless CLI that reads and writes
  only the local files named on the command line.

## Prerequisites

macOS with Xcode (command line tools) for the native helpers. `process` and `gif` also need
a Playwright Chromium (`npx playwright install chromium`). `caption` needs `ffmpeg` and
WhisperX on PATH.

## Build, test, lint

```bash
npm install
npm run build              # tsc + the headless render harness bundle
npm run build:native:mac   # macOS only: compiles the Swift helpers into bin/
npm test                   # vitest run
npm run lint               # biome check .
node dist/cli.js --version && node dist/cli.js --help
```

Some `record` tests run the real built CLI, so the native helpers must exist in `bin/`
before `npm test`.

## CLI surface (`src/cli.ts` builds to `dist/cli.js`, bin: `lensmith`)

`record`, `suggest-zooms`, `compose`, `process`, `gif`, `caption`, `package`.

## Repository layout

- `src/cli.ts`, `src/commands/` - one file per subcommand
- `src/lib/` - shared logic (recording session, cursor telemetry, zoom suggestion, harness runner)
- `src/harness/` - the headless render harness (bundled by `scripts/build-harness.mjs`)
- `src/native/` - Swift helpers (`screencapturekit/` is vendored; `lensmith-helpers/` is Lensmith's own)
- `vendor/openscreen/` - OpenScreen source, vendored verbatim
- `tests/`, `tests/fixtures/` - vitest suites and recorded fixtures
- `scripts/` - build scripts

## Vendoring rule

Code under `vendor/` and `src/native/screencapturekit/` is copied byte-for-byte from
OpenScreen at a pinned upstream commit. Do not edit it. If a change is unavoidable, mark it
inline with a `LENSMITH:` comment and disclose it in `NOTICE.md`. Every vendored file keeps
its attribution header; `NOTICE.md` lists the vendored paths and the pinned commit.

## Conventions

- English only. No credentials in code.
- Branches: `feature/<id>-<description>`; open a pull request into `main`.
- Never stage `.env`, `node_modules`, `dist`, `bin` or other build artifacts.

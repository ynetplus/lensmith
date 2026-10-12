# Contributing to Lensmith

Thanks for helping. This guide covers how to build, test and submit a change.

## Prerequisites

- macOS with the Xcode command line tools (`xcode-select --install`) for the native Swift
  helpers.
- Node.js 18 or newer (`engines` in `package.json`); CI runs Node 20.
- A Playwright Chromium for `process` and `gif`: `npx playwright install chromium`.
- `ffmpeg` and WhisperX on PATH if you work on `caption` or `package`.

## Build, test, lint

```bash
npm install
npm run build              # tsc + the headless render harness bundle
npm run build:native:mac   # macOS only: compiles the Swift helpers into bin/
npm test                   # vitest run
npm run lint               # biome check .
```

Some `record` tests run the real built CLI, so build the native helpers into `bin/` before
`npm test`. Run `npm run lint` and `npm test` before you open a pull request.

## The vendoring rule

Code under `vendor/` and `src/native/screencapturekit/` is copied byte-for-byte from
[OpenScreen](https://github.com/siddharthvaddem/openscreen) (MIT) at a pinned upstream
commit. Do not edit it.

If a change to vendored code is unavoidable:

1. Mark the edit inline with a `LENSMITH:` comment.
2. Disclose it in [`NOTICE.md`](./NOTICE.md), which lists the vendored paths and the
   pinned commit.
3. Keep the attribution header of every vendored file.

When you add a new vendored file or bump the pinned commit, update `NOTICE.md` in the same
pull request.

## Branches and pull requests

- Branch from `main` as `feature/<short-description>` or `fix/<short-description>`.
- Open a pull request into `main`. Keep it focused on one change, with tests.
- Never commit `.env`, `node_modules`, `dist`, `bin` or other build artifacts, and never
  commit credentials.
- English only in code, comments and docs.

## Commit identity

Use your own name and a real email address. Company authors commit with their
`@ynetplus.ca` address. Do not commit under a shared or placeholder identity.

## Licence of contributions

Lensmith is licensed under [Apache-2.0](./LICENSE). By submitting a contribution you agree
that it is licensed under the same terms (inbound = outbound), as described in section 5
of the licence.

## Reporting security issues

Do not use public issues for vulnerabilities. See [`SECURITY.md`](./SECURITY.md).

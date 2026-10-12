# Security Policy

## Supported versions

Lensmith is pre-1.0. Only the latest `0.x` release receives security fixes.

| Version | Supported |
|---|---|
| latest `0.x` | yes |
| older `0.x` | no |

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue.

Use a GitHub private security advisory on the repository:
<https://github.com/ynetplus/lensmith/security/advisories/new>

We aim to acknowledge a report within 72 hours. Please include the affected version or
commit, the steps to reproduce, and the impact you see.

## What Lensmith accesses

Lensmith is a stateless command-line tool. It reads and writes only the local files named
on the command line. The accesses below are all it makes.

- **Screen pixels.** `lensmith record` captures the main display or one window through
  ScreenCaptureKit. macOS asks for the Screen Recording permission; the helper checks it
  with `CGPreflightScreenCaptureAccess` and requests it with `CGRequestScreenCaptureAccess`.
- **System audio, only with `--system-audio`.** Off by default.
- **Microphone, only with `--mic`.** Off by default. macOS asks for the Microphone
  permission.
- **Pointer position.** A small helper polls the global pointer position while recording
  so the cursor can be drawn in the render. This needs no extra permission.
- **Mouse clicks and cursor shape.** A second helper installs a listen-only event tap on
  left mouse down and up, and reads the accessibility element under the pointer to learn
  the cursor shape. The cursor shape needs the macOS Accessibility permission; without it
  Lensmith skips the cursor shape and still records. Key presses are not read.
- **Local files you point it at.** `process`, `gif`, `compose`, `suggest-zooms`,
  `caption` and `package` read the input paths you give them and write the output paths
  you give them. `caption` also uses a temporary directory under the system temp folder,
  and runs `ffmpeg` and WhisperX if you have them installed.

Recording output (video, `.cursor.json`, `.session.json`) is written next to the path
given to `--out`. Cursor telemetry contains pointer coordinates and click timing for the
recorded session.

## Network

Lensmith makes no network calls of its own. It has no telemetry, no update check and no
upload. Rendering (`process`, `gif`) launches a local headless Chromium through
Playwright. That page is served from memory under a placeholder origin
(`https://lensmith.harness`); every request to it is intercepted by Playwright and
answered from local files, so nothing leaves the machine and no port is opened.

Installing dependencies (`npm install`) and the Playwright Chromium download
(`npx playwright install chromium`) use the network, as does anything you run outside
Lensmith.

## Out of scope

- Content of the recordings. Lensmith records whatever is on screen, so passwords or
  personal data visible during a recording end up in the video. Review before sharing.
- Vulnerabilities in third-party dependencies that are already public and tracked
  upstream (report them to the dependency; tell us if we should bump a version).
- Issues that require an attacker who already has local code execution as the user, or
  who can change the files the user passes in.
- Third-party tools Lensmith calls when present: `ffmpeg`, WhisperX, Chromium.
- Denial of service through very large or malformed input files.

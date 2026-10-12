# NOTICE

Lensmith is © 2026 YNET Plus Inc., licensed under the Apache License, Version 2.0 (see `LICENSE`).

## Third-party code

The OpenScreen section below is MIT-licensed code vendored into this repository; its
licence text is reproduced in full at the end of this section. Runtime dependencies
installed from npm are listed under "Runtime dependencies" at the end of this file.

Lensmith is built by re-hosting reusable, non-Electron-coupled pieces of
[OpenScreen](https://github.com/siddharthvaddem/openscreen) behind a
scriptable CLI. Specifically:

- Screen + audio capture (`OpenScreenScreenCaptureKitHelper`, Swift/ScreenCaptureKit)
- Cursor telemetry capture (`OpenScreenMacOSCursorHelper`, Swift)
- **Auto-zoom region detection (`zoomSuggestionUtils.ts`)** — vendored verbatim as
  `src/lib/zoomSuggestion.ts` by CR-LENSMITH-A001-3, pinned to upstream commit
  [`f57e36e25448b5af6c7b1b271066fe5beb9b8a49`](https://github.com/siddharthvaddem/openscreen/commit/f57e36e25448b5af6c7b1b271066fe5beb9b8a49)
  (retrieved 2026-08-11). Same pin applies to the `ZoomRegion`/`ZoomFocus`/
  `CursorTelemetryPoint` type subset ported alongside it from `types.ts`.
- Video processing/export (`videoExporter.ts`, `frameRenderer.ts`, `muxer.ts`,
  `streamingDecoder.ts`, `audioEncoder.ts`, `mp4ExportSettings.ts`, `gifExporter.ts`)
- The `EditorProjectData` project-file schema (`projectPersistence.ts`)

Each piece is vendored verbatim, with its own attribution comment at the
point of use, by the feature CR that introduces it (CR-LENSMITH-A002..A006).
This file establishes the license groundwork; CR-LENSMITH-A001-3 is the first
CR to actually vendor OpenScreen source (the auto-zoom decision layer, above).

### Vendored so far

- **`src/native/screencapturekit/`** (CR-LENSMITH-A001-2, 2026-08-11) —
  `Package.swift`, `Sources/OpenScreenScreenCaptureKitHelper/main.swift` (673
  lines), `Sources/OpenScreenMacOSCursorHelper/main.swift` (352 lines).
  Vendored **byte-identical**, no modifications, pinned at upstream commit
  [`f57e36e25448b5af6c7b1b271066fe5beb9b8a49`](https://github.com/siddharthvaddem/openscreen/commit/f57e36e25448b5af6c7b1b271066fe5beb9b8a49)
  (2026-06-16). A future upstream security fix is a traceable diff against
  this SHA, not a mystery.

  `src/native/lensmith-helpers/` (also added in CR-LENSMITH-A001-2) is
  **not** vendored — it is Lensmith's own code (a small native helper that
  polls cursor screen position, filling a gap the vendored cursor helper
  deliberately leaves to Electron's own APIs upstream, which Lensmith has
  none of). No attribution applies to it; see its `Package.swift` header
  for the full rationale.

### CR-LENSMITH-A001-4 — `process` / `gif` render harness

Vendored under `vendor/openscreen/src/` (mirrors upstream's own directory
layout so `@/...` import aliases resolve unmodified): the exporter module
(`lib/exporter/*` — `videoExporter.ts`, `frameRenderer.ts`, `muxer.ts`,
`streamingDecoder.ts`, `audioEncoder.ts`, `mp4ExportSettings.ts`,
`gifExporter.ts`, `videoDecoder.ts`, `annotationRenderer.ts`,
`gradientParser.ts`, `threeDPass.ts`, `webcamFrameDrawing.ts`,
`timestampedVideoFrameQueue.ts`, `asyncVideoFrameQueue.ts`, `types.ts`,
`index.ts`), the zoom/cursor render-support modules it imports
(`components/video-editor/types.ts` and `videoPlayback/*`,
`lib/annotationTextAnimation.ts`, `lib/blurEffects.ts`,
`lib/compositeLayout.ts`, `lib/cursor/*`, `lib/wallpaper.ts`,
`lib/webcamMaskShapes.ts`, `lib/assetPath.ts`, `native/contracts.ts`,
`utils/platformUtils.ts`, `utils/aspectRatioUtils.ts`), the native-cursor
theme SVG assets (`assets/cursors/*.svg`), and one wallpaper image used by
the reference fixture (`public/wallpapers/wallpaper1.jpg` — the app ships
18; only the one the acceptance fixture references is vendored here, see
the CR-LENSMITH-A001-4 forge report). All commit
`f57e36e25448b5af6c7b1b271066fe5beb9b8a49` (2026-06-16). Each vendored file
carries its own header attribution comment. Two constants in
`videoExporter.ts` (`ENCODER_STALL_TIMEOUT_MS`, `ENCODER_FLUSH_TIMEOUT_MS`)
were widened from upstream's Electron/hardware-tuned values — the only
non-verbatim change, disclosed inline (`LENSMITH:` comment) and in the
forge report.

### CR-LENSMITH-A007-9 — Settle zoom pacing (modified vendored files)

Two vendored files are **modified** from upstream commit
`f57e36e25448b5af6c7b1b271066fe5beb9b8a49`, every change marked inline with
`LENSMITH:` (`vendor/openscreen/src/components/video-editor/videoPlayback/`):

- `constants.ts` — zoom-in window 1522.6 ms to 900 ms, zoom-out window 1015.05 ms to
  700 ms, connected-pan duration 1000 ms to 700 ms (moved here from `zoomRegionUtils.ts`),
  and one shared curve `cubic-bezier(0.4, 0, 0.2, 1)` (`SETTLE_CURVE`).
- `zoomRegionUtils.ts` — the zoom-in window now starts at the region's `startMs` (upstream
  ended it 500 ms after `startMs`); zoom in, zoom out and the connected pan use the shared
  curve; the 1500 ms time-gap chaining rule is replaced by the region's `connect` flag
  (absent means false, so older zoom fragments zoom out between regions).

These are the "Settle" pacing values (provisional until locked after review).

OpenScreen is licensed under the MIT License:

```
MIT License

Copyright (c) 2025 Siddharth Vaddem

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Source: [github.com/siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen), `LICENSE` file, retrieved 2026-08-11.

## Runtime dependencies

Direct runtime dependencies (`dependencies` in `package.json`). Licences were measured
from each installed package's `LICENSE` file (and `package.json` / `npm view`) on
2026-10-11; versions are those resolved by `package-lock.json`.

| Package | Version | Licence | Notes |
|---|---|---|---|
| [commander](https://github.com/tj/commander.js) | 12.1.0 | MIT | |
| [gif.js](https://github.com/jnordberg/gif.js) | 0.2.0 | MIT | Licence stated in `package.json`; the package ships no LICENSE file. |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | 1.53.0 | MPL-2.0 | See below. |
| [motion](https://github.com/motiondivision/motion) | 12.43.0 | MIT | |
| [mp4box](https://github.com/gpac/mp4box.js) | 2.4.1 | BSD-3-Clause | |
| [pixi-filters](https://github.com/pixijs/filters) | 6.1.5 | MIT | |
| [pixi.js](https://github.com/pixijs/pixijs) | 8.19.0 | MIT | |
| [playwright](https://github.com/microsoft/playwright) | 1.62.1 | Apache-2.0 | |
| [web-demuxer](https://github.com/ForeverSc/web-demuxer) | 4.0.0 | MIT (wrapper) | Bundled WASM is FFmpeg-derived, LGPL. See below. |

### mediabunny (MPL-2.0)

Lensmith imports `mediabunny` as an unmodified library from npm. The Mozilla Public
License 2.0 is a file-level copyleft: it applies to the files of `mediabunny` itself
and does not extend to Lensmith's own code that merely uses it (MPL-2.0 section 3.3,
"Larger Works"). Lensmith does not modify `mediabunny`. Source and licence text:
<https://github.com/Vanilagy/mediabunny>.

### web-demuxer (MIT wrapper, LGPL FFmpeg-derived WASM)

`web-demuxer` is an MIT-licensed wrapper. Per its README, its `lib/` directory and the
WebAssembly binaries it ships (`web-demuxer.wasm`, `web-demuxer-mini.wasm`) contain
FFmpeg-derived code under the LGPL. Lensmith does not modify or statically link that
code: the WASM files are loaded at run time as separate assets, so they can be replaced
with a rebuilt copy. Source and licence text: <https://github.com/ForeverSc/web-demuxer>
(FFmpeg source: <https://ffmpeg.org/download.html>). `web-demuxer`'s `package.json` has
no `license` field; the MIT grant is measured from its `LICENSE` file.

// swift-tools-version: 5.9
//
// Lensmith's own native helper package (CR-LENSMITH-A001-2). This is NOT
// vendored from OpenScreen — unlike `src/native/screencapturekit/`, every
// line here is Lensmith's own code, so no upstream attribution applies.
//
// Why this exists: the vendored OpenScreenMacOSCursorHelper (see
// screencapturekit/Sources/OpenScreenMacOSCursorHelper) reports cursor
// SHAPE (arrow/pointer/text) and click state, but deliberately never emits
// the cursor's screen position — in the upstream Electron app, position
// comes from Electron's own `screen.getCursorScreenPoint()`, called by the
// Electron main process at the moment each shape sample arrives
// (electron/native-bridge/cursor/recording/macNativeCursorRecordingSession.ts).
// Lensmith has no Electron. AppleScript/JXA (`osascript -l JavaScript`,
// which can bridge to `NSEvent.mouseLocation`) was evaluated and rejected:
// measured 2.7-5.3s per invocation in this environment — completely
// unusable at the ~33ms sample cadence the cursor helper uses. This tiny
// compiled helper polls `CGEventGetLocation` directly (no AppleScript
// engine involved) at the same low latency as the vendored helpers.
import PackageDescription

let package = Package(
	name: "LensmithCursorPositionHelper",
	platforms: [
		.macOS(.v13)
	],
	products: [
		.executable(
			name: "lensmith-cursor-position-helper",
			targets: ["LensmithCursorPositionHelper"]
		)
	],
	targets: [
		.executableTarget(
			name: "LensmithCursorPositionHelper",
			path: "Sources/LensmithCursorPositionHelper"
		)
	]
)

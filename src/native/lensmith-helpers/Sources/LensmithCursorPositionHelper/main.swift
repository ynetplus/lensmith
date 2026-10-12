import CoreGraphics
import Foundation

// Lensmith's own helper — NOT vendored, no upstream attribution applies.
// See Package.swift in this directory for why it exists: the vendored
// OpenScreenMacOSCursorHelper reports cursor shape/click state but never
// screen position (upstream gets that from Electron's own
// `screen.getCursorScreenPoint()`, which has no equivalent outside
// Electron). This polls `CGEventGetLocation` in a tight loop — the same
// approach the vendored cursor helper uses for its own sampling loop, just
// for position instead of shape — so `record.ts` can merge the two NDJSON
// streams into one `.cursor.json` (CR-LENSMITH-A001-2).
//
// CGEventGetLocation's coordinate space is top-left-origin, in points, and matches
// CGDisplayBounds (point<->pixel conversion is by the display scale; see BF-18 below).

struct PositionHelperRequest: Decodable {
	let sampleIntervalMs: Int?
	/// BF-19: when set, the helper also reports this window's frame (global points, same
	/// top-left-origin space as the cursor location) so cursor samples can be normalized to
	/// the window instead of the display.
	let windowId: UInt32?
}

/// BF-19: the on-screen frame of `windowId` in global points, or nil when not found.
func windowFrame(_ windowId: UInt32) -> [String: Double]? {
	guard
		let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(windowId))
			as? [[String: Any]],
		let info = list.first,
		let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
		let rect = CGRect(dictionaryRepresentation: boundsDict)
	else { return nil }
	return ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}

func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

func timestampMs() -> Int {
	Int(Date().timeIntervalSince1970 * 1000)
}

let request: PositionHelperRequest
if CommandLine.arguments.count >= 2,
	let data = CommandLine.arguments[1].data(using: .utf8),
	let decoded = try? JSONDecoder().decode(PositionHelperRequest.self, from: data)
{
	request = decoded
} else {
	request = PositionHelperRequest(sampleIntervalMs: nil, windowId: nil)
}

// Sampled faster than the cursor-shape helper's own default (33ms) so a
// shape sample is never waiting on a stale position reading.
let intervalMs = max(4, request.sampleIntervalMs ?? 16)

let mainDisplayId = CGMainDisplayID()
let bounds = CGDisplayBounds(mainDisplayId)

// BF-18: CGDisplayPixelsWide/High return POINTS on a HiDPI display (a 1920x1080@2x
// display reports 1920x1080, not 3840x2160). The capture size ceiling must be real
// pixels, which the display mode carries as pixelWidth/pixelHeight. The point size
// stays available as pointWidth/pointHeight. Falls back to CGDisplayPixels* only if
// the mode cannot be read (1x displays: identical values).
let displayMode = CGDisplayCopyDisplayMode(mainDisplayId)
let pixelWidth = displayMode?.pixelWidth ?? CGDisplayPixelsWide(mainDisplayId)
let pixelHeight = displayMode?.pixelHeight ?? CGDisplayPixelsHigh(mainDisplayId)
var lastWindowFrame: [String: Double]? = request.windowId.flatMap { windowFrame($0) }
var readyFields: [String: Any] = [
	"type": "ready",
	"timestampMs": timestampMs(),
	"displayId": mainDisplayId,
	"bounds": [
		"x": bounds.origin.x,
		"y": bounds.origin.y,
		"width": bounds.width,
		"height": bounds.height,
	],
	"pixelWidth": pixelWidth,
	"pixelHeight": pixelHeight,
	"pointWidth": CGDisplayPixelsWide(mainDisplayId),
	"pointHeight": CGDisplayPixelsHigh(mainDisplayId),
]
if let frame = lastWindowFrame { readyFields["windowFrame"] = frame }
emit(readyFields)
var loopCount = 0

while true {
	autoreleasepool {
		// BF-19: re-read the window frame about every 250ms; report only a change.
		loopCount += 1
		if let windowId = request.windowId, loopCount % max(1, 250 / intervalMs) == 0,
			let frame = windowFrame(windowId), frame != lastWindowFrame
		{
			lastWindowFrame = frame
			emit(["type": "windowFrame", "timestampMs": timestampMs(), "frame": frame])
		}
		if let event = CGEvent(source: nil) {
			let location = event.location
			emit([
				"type": "sample",
				"timestampMs": timestampMs(),
				"x": location.x,
				"y": location.y,
			])
		}
		Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
	}
}

import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct Rectangle: Decodable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

struct RecordingRequest: Decodable {
	struct Source: Decodable {
		let type: String
		let sourceId: String
		let displayId: UInt32?
		let windowId: UInt32?
		let bounds: Rectangle?
	}

	struct Video: Decodable {
		let fps: Int
		let width: Int
		let height: Int
		let bitrate: Int?
		let hideSystemCursor: Bool
	}

	struct Audio: Decodable {
		struct SystemAudio: Decodable {
			let enabled: Bool
		}

		struct Microphone: Decodable {
			let enabled: Bool
			let deviceId: String?
			let deviceName: String?
			let gain: Double
		}

		let system: SystemAudio
		let microphone: Microphone
	}

	struct Webcam: Decodable {
		let enabled: Bool
		let deviceId: String?
		let deviceName: String?
		let width: Int
		let height: Int
		let fps: Int
	}

	struct Cursor: Decodable {
		let mode: String
	}

	struct Outputs: Decodable {
		let screenPath: String
		let manifestPath: String?
	}

	let schemaVersion: Int?
	let recordingId: Int?
	let source: Source
	let video: Video
	let audio: Audio
	let webcam: Webcam
	let cursor: Cursor
	let outputs: Outputs
}

enum HelperError: Error, CustomStringConvertible {
	case invalidArguments
	case unsupportedMacOS
	case unsupportedFeature(String)
	case sourceNotFound(String)
	case invalidSourceType(String)
	case permissionDenied(String)
	case writerSetupFailed(String)

	var description: String {
		switch self {
		case .invalidArguments:
			return "Expected one JSON recording request argument."
		case .unsupportedMacOS:
			return "ScreenCaptureKit recording requires macOS 13 or newer."
		case .unsupportedFeature(let message):
			return message
		case .sourceNotFound(let message):
			return message
		case .invalidSourceType(let sourceType):
			return "Unsupported source type: \(sourceType)."
		case .permissionDenied(let message):
			return message
		case .writerSetupFailed(let message):
			return message
		}
	}
}

func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

func emitError(code: String, message: String) {
	emit([
		"event": "error",
		"code": code,
		"message": message,
	])
}

@available(macOS 13.0, *)
final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private struct CaptureTarget {
		let filter: SCContentFilter
		let width: Int
		let height: Int
		/// `region` only: the captured rectangle in display-local points (CR-LENSMITH-A010-7).
		var sourceRect: CGRect? = nil
	}

	private let request: RecordingRequest
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	private var writer: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	private var systemAudioInput: AVAssetWriterInput?
	private var microphoneAudioInput: AVAssetWriterInput?
	private var didStartWriting = false
	private var didEmitRecordingStarted = false
	private var isStopping = false
	private var stopTask: Task<Bool, Never>?
	private var isPaused = false
	private var pauseStartedAt: CMTime?
	private var totalPausedDuration = CMTime.zero
	private var nativeMicrophoneEnabled = false
	private var outputWidth = 1920
	private var outputHeight = 1080
	private var outputSourceRect: CGRect?
	private let microphoneOutputTypeRawValue = 2
	private let hostClock = CMClockGetHostTimeClock()
	// LENSMITH: BF-24 — ScreenCaptureKit only delivers a frame when the content changes, so a
	// static screen at the end of a recording left the file shorter than the recorded span. The
	// last appended frame is retained (sampleQueue only) and held to the stop time in stop().
	private var lastVideoPixelBuffer: CVPixelBuffer?
	private var lastVideoFormat: CMFormatDescription?
	private var lastVideoPresentationTime: CMTime?
	private var sessionStartTime: CMTime?
	private var stopPresentationTime: CMTime?

	init(request: RecordingRequest) {
		self.request = request
	}

	func start() async throws {
		try ensureRequestedPermissions()

		let content = try await SCShareableContent.excludingDesktopWindows(
			false,
			onScreenWindowsOnly: true
		)
		let target = try makeCaptureTarget(from: content)
		outputWidth = target.width
		outputHeight = target.height
		outputSourceRect = target.sourceRect
		let configuration = makeStreamConfiguration()
		let stream = SCStream(filter: target.filter, configuration: configuration, delegate: self)

		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		if request.audio.system.enabled {
			try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
		}
		if nativeMicrophoneEnabled {
			guard let microphoneOutputType = SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) else {
				throw HelperError.unsupportedFeature(
					"Native microphone capture requires a macOS version with ScreenCaptureKit microphone output."
				)
			}
			try stream.addStreamOutput(self, type: microphoneOutputType, sampleHandlerQueue: sampleQueue)
		}
		try setupWriter()

		self.stream = stream
		emit(["event": "ready", "schemaVersion": 1])
		try await stream.startCapture()
	}

	/// Idempotent and race-free: SIGINT, the stdin "stop" command, and a stream-error callback can
	/// all reach this concurrently. Every caller awaits the SAME task, so whichever one arrives
	/// first owns the real shutdown and every other caller observes its actual outcome — instead of
	/// each racing to `exit()` independently while only one of them actually finalized the writer
	/// (BF-6: a caller must never report success it did not itself confirm).
	func stop() -> Task<Bool, Never> {
		stateQueue.sync { () -> Task<Bool, Never> in
			if let stopTask {
				return stopTask
			}
			isStopping = true
			// LENSMITH: BF-24 — the stop time on the same (pause-retimed) clock as the frames.
			let now = CMClockGetTime(hostClock)
			let effectiveNow = isPaused ? (pauseStartedAt ?? now) : now
			stopPresentationTime = CMTimeSubtract(effectiveNow, totalPausedDuration)
			let task = Task { [weak self] () -> Bool in
				guard let self else { return false }
				do {
					try await self.stream?.stopCapture()
				} catch {
					emit([
						"event": "warning",
						"code": "stop-capture-failed",
						"message": "\(error)",
					])
				}
				return await self.finishWriter()
			}
			stopTask = task
			return task
		}
	}

	func pause() {
		let didPause = stateQueue.sync {
			if isStopping || isPaused {
				return false
			}

			isPaused = true
			pauseStartedAt = CMClockGetTime(hostClock)
			return true
		}

		if didPause {
			emit([
				"event": "recording-paused",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func resume() {
		let didResume = stateQueue.sync {
			if isStopping || !isPaused {
				return false
			}

			if let pauseStartedAt {
				let now = CMClockGetTime(hostClock)
				totalPausedDuration = CMTimeAdd(
					totalPausedDuration,
					CMTimeSubtract(now, pauseStartedAt)
				)
			}
			isPaused = false
			pauseStartedAt = nil
			return true
		}

		if didResume {
			emit([
				"event": "recording-resumed",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		emitError(code: "capture-stopped-with-error", message: "\(error)")
		Task {
			_ = await stop().value
		}
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		let pauseState = currentPauseState()
		if pauseState.paused {
			return
		}
		guard let sampleBuffer = retimedSampleBuffer(sampleBuffer, subtracting: pauseState.offset) else {
			return
		}

		if type == .audio {
			appendAudioSampleBuffer(sampleBuffer, to: systemAudioInput)
			return
		}

		if type.rawValue == microphoneOutputTypeRawValue {
			appendAudioSampleBuffer(sampleBuffer, to: microphoneAudioInput)
			return
		}

		guard type == .screen else {
			return
		}
		guard isCompleteFrame(sampleBuffer) else {
			return
		}
		guard let videoInput, let writer else {
			return
		}
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		if !didStartWriting {
			writer.startWriting()
			writer.startSession(atSourceTime: presentationTime)
			sessionStartTime = presentationTime // LENSMITH: BF-24
			didStartWriting = true
		}

		if videoInput.isReadyForMoreMediaData {
			let appended = videoInput.append(sampleBuffer)
			if appended {
				// LENSMITH: BF-24 — remember the last frame so stop() can hold it to the stop time.
				lastVideoPixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
				lastVideoFormat = CMSampleBufferGetFormatDescription(sampleBuffer)
				lastVideoPresentationTime = presentationTime
			}
			if appended, !didEmitRecordingStarted {
				didEmitRecordingStarted = true
				emit([
					"event": "recording-started",
					"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
					"width": outputWidth,
					"height": outputHeight,
				])
			}
		}
	}

	private func ensureRequestedPermissions() throws {
		if !CGPreflightScreenCaptureAccess() {
			let granted = CGRequestScreenCaptureAccess()
			if !granted {
				throw HelperError.permissionDenied("Screen recording permission is required for ScreenCaptureKit capture.")
			}
		}

		if request.audio.microphone.enabled {
			switch AVCaptureDevice.authorizationStatus(for: .audio) {
			case .authorized:
				break
			case .notDetermined:
				let semaphore = DispatchSemaphore(value: 0)
				AVCaptureDevice.requestAccess(for: .audio) { _ in
					semaphore.signal()
				}
				let waitResult = semaphore.wait(timeout: .now() + 30)
				if waitResult == .timedOut || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
					throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
				}
			default:
				throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
			}
		}
	}

	private func makeCaptureTarget(from content: SCShareableContent) throws -> CaptureTarget {
		switch request.source.type {
		case "display":
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Display capture requires source.displayId.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			let width = Int(CGDisplayPixelsWide(display.displayID))
			let height = Int(CGDisplayPixelsHigh(display.displayID))
			return CaptureTarget(
				filter: SCContentFilter(display: display, excludingWindows: []),
				width: clampCaptureDimension(width, fallback: request.video.width),
				height: clampCaptureDimension(height, fallback: request.video.height)
			)
		case "window":
			guard let windowId = request.source.windowId else {
				throw HelperError.sourceNotFound("Window capture requires source.windowId.")
			}
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit window found for id \(windowId).")
			}
			let candidateDisplay = content.displays.first {
				$0.frame.intersects(window.frame) || $0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY))
			}
			let scaleFactor = Self.scaleFactor(for: candidateDisplay?.displayID ?? CGMainDisplayID())
			let width = Int(window.frame.width) * scaleFactor
			let height = Int(window.frame.height) * scaleFactor
			return CaptureTarget(
				filter: SCContentFilter(desktopIndependentWindow: window),
				width: clampCaptureDimension(width, fallback: request.video.width),
				height: clampCaptureDimension(height, fallback: request.video.height)
			)
		case "region":
			// CR-LENSMITH-A010-7: a rectangle of one display — a display filter cropped with
			// `sourceRect`, so menus, popovers, the menu bar and several windows all show.
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Region capture requires source.displayId.")
			}
			guard let bounds = request.source.bounds else {
				throw HelperError.sourceNotFound("Region capture requires source.bounds.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			let region = CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
			let displayRect = CGRect(origin: .zero, size: display.frame.size)
			guard region.width > 0, region.height > 0, displayRect.contains(region) else {
				throw HelperError.sourceNotFound(
					"Region \(Int(bounds.x)),\(Int(bounds.y)),\(Int(bounds.width)),\(Int(bounds.height)) is outside display \(displayId) (\(Int(display.frame.width))x\(Int(display.frame.height)) points)."
				)
			}
			let scaleFactor = Self.scaleFactor(for: display.displayID)
			let width = Int(region.width) * scaleFactor
			let height = Int(region.height) * scaleFactor
			return CaptureTarget(
				filter: SCContentFilter(display: display, excludingWindows: []),
				width: clampCaptureDimension(width, fallback: request.video.width),
				height: clampCaptureDimension(height, fallback: request.video.height),
				sourceRect: region
			)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	private func makeStreamConfiguration() -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = outputWidth
		configuration.height = outputHeight
		if let outputSourceRect {
			configuration.sourceRect = outputSourceRect
		}
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
		configuration.queueDepth = 6
		configuration.showsCursor = !request.video.hideSystemCursor
		configuration.pixelFormat = kCVPixelFormatType_32BGRA
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		configuration.capturesAudio = request.audio.system.enabled

		if request.audio.microphone.enabled {
			guard supportsNativeMicrophoneCapture(streamConfig: configuration) else {
				nativeMicrophoneEnabled = false
				emit([
					"event": "warning",
					"code": "microphone-unavailable",
					"message": "Native microphone capture requires ScreenCaptureKit microphone support on this macOS version.",
				])
				return configuration
			}
			nativeMicrophoneEnabled = true
			configuration.capturesAudio = true
			configuration.setValue(true, forKey: "captureMicrophone")
			if let deviceId = resolveMicrophoneCaptureDeviceID() {
				configuration.setValue(deviceId, forKey: "microphoneCaptureDeviceID")
			}
		} else {
			nativeMicrophoneEnabled = false
		}

		return configuration
	}

	private func setupWriter() throws {
		let outputUrl = URL(fileURLWithPath: request.outputs.screenPath)
		try? FileManager.default.removeItem(at: outputUrl)
		try FileManager.default.createDirectory(
			at: outputUrl.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)

		let writer = try AVAssetWriter(outputURL: outputUrl, fileType: .mp4)
		let settings: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outputWidth,
			AVVideoHeightKey: outputHeight,
			AVVideoCompressionPropertiesKey: [
				AVVideoAverageBitRateKey: request.video.bitrate ?? 18_000_000,
				AVVideoExpectedSourceFrameRateKey: request.video.fps,
			],
		]
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add H.264 video input to AVAssetWriter.")
		}

		writer.add(input)
		self.writer = writer
		self.videoInput = input

		if request.audio.system.enabled {
			systemAudioInput = try addAudioInput(to: writer, bitRate: 192_000)
		}
		if nativeMicrophoneEnabled {
			microphoneAudioInput = try addAudioInput(to: writer, bitRate: 128_000)
		}
	}

	/// Returns whether the container was actually finalized. `finishWriting`'s completion handler
	/// firing is not itself success — it fires on `.failed` too — so the caller (which decides the
	/// process's own exit code) must key off `writer.status`, not off having reached this point at
	/// all (BF-6: a caller exiting 0 without checking this is exactly the false-success defect).
	private func finishWriter() async -> Bool {
		guard let writer else {
			return false
		}

		appendHeldFrameIfStale() // LENSMITH: BF-24
		videoInput?.markAsFinished()
		systemAudioInput?.markAsFinished()
		microphoneAudioInput?.markAsFinished()

		await withCheckedContinuation { continuation in
			writer.finishWriting {
				continuation.resume()
			}
		}

		guard writer.status == .completed else {
			emitError(
				code: "writer-failed",
				message: writer.error.map { "\($0)" } ?? "AVAssetWriter failed with status \(writer.status.rawValue)."
			)
			return false
		}

		var stoppedEvent: [String: Any] = [
			"event": "recording-stopped",
			"screenPath": request.outputs.screenPath,
		]
		// LENSMITH: BF-24 — the written film's duration, so the CLI can compare it with the span.
		if let durationMs = await writtenDurationMs() {
			stoppedEvent["durationMs"] = durationMs
		}
		emit(stoppedEvent)
		return true
	}

	/// LENSMITH: BF-24 — when the last appended frame is older than the stop time by more than one
	/// frame interval (a static screen: ScreenCaptureKit sent nothing new), append it once more at
	/// the stop time so the container's duration equals the recorded span. Variable-rate output is
	/// otherwise unchanged.
	private func appendHeldFrameIfStale() {
		sampleQueue.sync {
			guard didStartWriting,
				let videoInput,
				let pixelBuffer = lastVideoPixelBuffer,
				let format = lastVideoFormat,
				let lastTime = lastVideoPresentationTime,
				let stopTime = stopPresentationTime
			else {
				return
			}
			let frameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
			guard CMTimeCompare(CMTimeSubtract(stopTime, lastTime), frameInterval) > 0 else {
				return
			}
			var timing = CMSampleTimingInfo(
				duration: frameInterval,
				presentationTimeStamp: stopTime,
				decodeTimeStamp: .invalid
			)
			var heldSample: CMSampleBuffer?
			let status = CMSampleBufferCreateReadyWithImageBuffer(
				allocator: kCFAllocatorDefault,
				imageBuffer: pixelBuffer,
				formatDescription: format,
				sampleTiming: &timing,
				sampleBufferOut: &heldSample
			)
			guard status == noErr, let heldSample else {
				emit([
					"event": "warning",
					"code": "hold-frame-failed",
					"message": "Unable to build the held last frame: \(status).",
				])
				return
			}
			var waits = 0
			while !videoInput.isReadyForMoreMediaData, waits < 100 {
				usleep(10_000)
				waits += 1
			}
			if videoInput.isReadyForMoreMediaData, videoInput.append(heldSample) {
				lastVideoPresentationTime = stopTime
			} else {
				emit([
					"event": "warning",
					"code": "hold-frame-failed",
					"message": "The writer did not accept the held last frame.",
				])
			}
		}
	}

	/// LENSMITH: BF-24 — read back from the finished file; falls back to the appended span.
	private func writtenDurationMs() async -> Int? {
		let asset = AVURLAsset(url: URL(fileURLWithPath: request.outputs.screenPath))
		if let duration = try? await asset.load(.duration), duration.isValid, duration.seconds > 0 {
			return Int((duration.seconds * 1000).rounded())
		}
		let span: CMTime? = sampleQueue.sync {
			guard let start = sessionStartTime, let last = lastVideoPresentationTime else { return nil }
			return CMTimeSubtract(last, start)
		}
		guard let span, span.isValid else { return nil }
		return Int((span.seconds * 1000).rounded())
	}

	private func addAudioInput(to writer: AVAssetWriter, bitRate: Int) throws -> AVAssetWriterInput {
		let settings: [String: Any] = [
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: 48_000,
			AVNumberOfChannelsKey: 2,
			AVEncoderBitRateKey: bitRate,
		]
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add AAC audio input to AVAssetWriter.")
		}

		writer.add(input)
		return input
	}

	private func appendAudioSampleBuffer(_ sampleBuffer: CMSampleBuffer, to input: AVAssetWriterInput?) {
		guard didStartWriting else {
			return
		}
		guard let input, input.isReadyForMoreMediaData else {
			return
		}

		input.append(sampleBuffer)
	}

	private func currentPauseState() -> (paused: Bool, offset: CMTime) {
		stateQueue.sync {
			(isPaused, totalPausedDuration)
		}
	}

	private func retimedSampleBuffer(_ sampleBuffer: CMSampleBuffer, subtracting offset: CMTime) -> CMSampleBuffer? {
		if !offset.isValid || offset == .zero {
			return sampleBuffer
		}

		let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
		if sampleCount <= 0 {
			return sampleBuffer
		}

		var timing = Array(repeating: CMSampleTimingInfo(), count: sampleCount)
		let timingStatus = CMSampleBufferGetSampleTimingInfoArray(
			sampleBuffer,
			entryCount: sampleCount,
			arrayToFill: &timing,
			entriesNeededOut: nil
		)
		if timingStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to read sample timing info: \(timingStatus).",
			])
			return sampleBuffer
		}

		for index in timing.indices {
			if timing[index].presentationTimeStamp.isValid {
				timing[index].presentationTimeStamp = CMTimeSubtract(
					timing[index].presentationTimeStamp,
					offset
				)
			}
			if timing[index].decodeTimeStamp.isValid {
				timing[index].decodeTimeStamp = CMTimeSubtract(timing[index].decodeTimeStamp, offset)
			}
		}

		var retimedBuffer: CMSampleBuffer?
		let copyStatus = CMSampleBufferCreateCopyWithNewTiming(
			allocator: kCFAllocatorDefault,
			sampleBuffer: sampleBuffer,
			sampleTimingEntryCount: sampleCount,
			sampleTimingArray: &timing,
			sampleBufferOut: &retimedBuffer
		)
		if copyStatus != noErr {
			emit([
				"event": "warning",
				"code": "sample-retime-failed",
				"message": "Unable to copy sample timing info: \(copyStatus).",
			])
			return sampleBuffer
		}

		return retimedBuffer
	}

	private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
			sampleBuffer,
			createIfNecessary: false
		) as? [[SCStreamFrameInfo: Any]],
			let attachment = attachments.first,
			let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int,
			let status = SCFrameStatus(rawValue: statusRawValue)
		else {
			return true
		}

		return status == .complete
	}

	private func clampCaptureDimension(_ value: Int, fallback: Int) -> Int {
		let requested = max(2, fallback)
		let candidate = value > 0 ? value : requested
		let clamped = min(candidate, requested)
		return max(2, clamped - (clamped % 2))
	}

	private static func scaleFactor(for displayId: CGDirectDisplayID) -> Int {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return 1
		}

		return max(1, mode.pixelWidth / max(1, mode.width))
	}

	private func supportsNativeMicrophoneCapture(streamConfig: SCStreamConfiguration) -> Bool {
		streamConfig.responds(to: Selector(("setCaptureMicrophone:"))) &&
			streamConfig.responds(to: Selector(("setMicrophoneCaptureDeviceID:"))) &&
			SCStreamOutputType(rawValue: microphoneOutputTypeRawValue) != nil
	}

	private func resolveMicrophoneCaptureDeviceID() -> String? {
		let devices = AVCaptureDevice.devices(for: .audio)

		if let deviceName = request.audio.microphone.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines),
			!deviceName.isEmpty,
			let device = devices.first(where: { $0.localizedName == deviceName })
		{
			return device.uniqueID
		}

		if let deviceId = request.audio.microphone.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines),
			!deviceId.isEmpty,
			devices.contains(where: { $0.uniqueID == deviceId })
		{
			return deviceId
		}

		return nil
	}
}

@main
struct OpenScreenScreenCaptureKitHelper {
	static func main() async {
		do {
			guard CommandLine.arguments.count == 2 else {
				throw HelperError.invalidArguments
			}

			guard #available(macOS 13.0, *) else {
				throw HelperError.unsupportedMacOS
			}

			let requestData = Data(CommandLine.arguments[1].utf8)
			let decoder = JSONDecoder()
			let request = try decoder.decode(RecordingRequest.self, from: requestData)
			let recorder = ScreenCaptureRecorder(request: request)

			// SIGINT's default disposition terminates the process immediately — on a real
			// terminal it reaches this helper directly (same foreground process group as the
			// CLI), racing ahead of the "stop" command the CLI also writes to stdin and killing
			// the process before finishWriter() ever runs, which is why every recording shipped
			// a moov-less mp4 and no sidecar files (BF-6). Trap it so a shutdown request always
			// reaches the same clean-stop path as the stdin "stop" command.
			signal(SIGINT, SIG_IGN)
			let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
			sigintSource.setEventHandler {
				Task {
					// exit(0) here used to be unconditional — a writer that finished in `.failed`
					// status still reported success to the CLI, which then printed the mp4 as
					// written. The parent's own exit-code trust made that a silent false success
					// (BF-6, round 2): only a confirmed-finalized write may exit 0.
					let succeeded = await recorder.stop().value
					exit(succeeded ? 0 : 1)
				}
			}
			sigintSource.resume()

			let stopTask = Task.detached {
				while let line = readLine() {
					let command = line.trimmingCharacters(in: .whitespacesAndNewlines)
					switch command {
					case "pause":
						recorder.pause()
					case "resume":
						recorder.resume()
					case "stop":
						let succeeded = await recorder.stop().value
						exit(succeeded ? 0 : 1)
					default:
						break
					}
				}
			}

			try await recorder.start()
			await stopTask.value
		} catch let error as HelperError {
			emitError(code: "helper-error", message: error.description)
			exit(1)
		} catch {
			emitError(code: "helper-error", message: "\(error)")
			exit(1)
		}
	}
}

/**
 * Vendored verbatim from OpenScreen (MIT, (c) 2025 Siddharth Vaddem).
 * Source: https://github.com/siddharthvaddem/openscreen
 * Commit: f57e36e25448b5af6c7b1b271066fe5beb9b8a49 (2026-06-16)
 * Path (upstream): src/lib/exporter/index.ts
 * See NOTICE.md. Unmodified except where noted inline with "LENSMITH:".
 */
export { FrameRenderer } from "./frameRenderer";
export { calculateOutputDimensions, GifExporter } from "./gifExporter";
export {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	type Mp4ExportSettings,
} from "./mp4ExportSettings";
export { VideoMuxer } from "./muxer";
export { StreamingVideoDecoder } from "./streamingDecoder";
export type {
	ExportConfig,
	ExportFormat,
	ExportProgress,
	ExportQuality,
	ExportResult,
	ExportSettings,
	GifExportConfig,
	GifFrameRate,
	GifSizePreset,
	VideoFrameData,
} from "./types";
export {
	GIF_FRAME_RATES,
	GIF_SIZE_PRESETS,
	isValidGifFrameRate,
	VALID_GIF_FRAME_RATES,
} from "./types";
export { VideoFileDecoder } from "./videoDecoder";
export { VideoExporter } from "./videoExporter";

/**
 * Vendored verbatim from OpenScreen (MIT, (c) 2025 Siddharth Vaddem).
 * Source: https://github.com/siddharthvaddem/openscreen
 * Commit: f57e36e25448b5af6c7b1b271066fe5beb9b8a49 (2026-06-16)
 * Path (upstream): src/lib/exporter/videoDecoder.ts
 * See NOTICE.md. Unmodified except where noted inline with "LENSMITH:".
 */
export interface DecodedVideoInfo {
	width: number;
	height: number;
	duration: number; // in seconds
	frameRate: number;
	codec: string;
}

export class VideoFileDecoder {
	private info: DecodedVideoInfo | null = null;
	private videoElement: HTMLVideoElement | null = null;

	async loadVideo(videoUrl: string): Promise<DecodedVideoInfo> {
		this.videoElement = document.createElement("video");
		this.videoElement.src = videoUrl;
		this.videoElement.preload = "metadata";

		return new Promise((resolve, reject) => {
			this.videoElement!.addEventListener("loadedmetadata", () => {
				const video = this.videoElement!;

				this.info = {
					width: video.videoWidth,
					height: video.videoHeight,
					duration: video.duration,
					frameRate: 60,
					codec: "avc1.640033",
				};

				resolve(this.info);
			});

			this.videoElement!.addEventListener("error", (e) => {
				reject(new Error(`Failed to load video: ${e}`));
			});
		});
	}

	/** The underlying video element, used for seeking. */
	getVideoElement(): HTMLVideoElement | null {
		return this.videoElement;
	}

	getInfo(): DecodedVideoInfo | null {
		return this.info;
	}

	destroy(): void {
		if (this.videoElement) {
			this.videoElement.pause();
			this.videoElement.src = "";
			this.videoElement = null;
		}
	}
}

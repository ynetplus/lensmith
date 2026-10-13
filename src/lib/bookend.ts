/**
 * Bookends (CR-LENSMITH-A011-3): the Veil opening (hook over the veiled first frame, lifted
 * on the Settle curve) and the Veil-down "Made with Lensmith" end card, as ratified in the
 * Carbon round CR-LENSMITH-A011-2 (cards "Bookend, open" and "Bookend, end").
 *
 * Every timing lives in `planBookend`. The renderer only samples `frameState(plan, ...)`,
 * so no number of the card spec is repeated anywhere else.
 */

export type BookendFormat = "16:9" | "9:16";

export interface Span {
	start: number;
	end: number;
}

export interface OpenPlan {
	/** The hook's spoken length V (the voice file's length, or the fixed default). */
	voiceMs: number;
	/** The veiled frame alone, nothing moves (0 to 200). */
	still: Span;
	/** Hook enters: opacity 0 to 1, rise 12 px, Ripple size curve. */
	hookIn: Span;
	/** Voice starts with the hook already on screen. */
	voiceStartMs: number;
	/** Veil 0.80 to 0 on the Settle curve (V + 1200 to V + 1900). Only drawn in 16:9. */
	lift: Span;
	/** Hook exits: opacity 1 to 0, translateY 0 to -12, Ripple fade curve (V + 1500 to V + 1900). */
	hookOut: Span;
	totalMs: number;
}

export interface EndPlan {
	/** Veil 0 to 0.80 on the Settle curve. Only drawn in 16:9. */
	veil: Span;
	/** "Made with" + lockup. */
	title: Span;
	install: Span;
	address: Span;
	holdMs: number;
	totalMs: number;
}

export interface TypeSpec {
	width: number;
	height: number;
	/** 16:9 draws the iron veil; 9:16 draws on the frame's own ground, no veil. */
	veil: boolean;
	veilOpacity: number;
	hook: { size: number; left: number; box: number; raise?: number; bottom?: number };
	hookRisePx: number;
	title: { size: number; lockupPx: number; left: number; bottom?: number };
	install: { size: number; gapAbove: number; top?: number };
	address: { size: number; gapAbove: number; opacity: number };
	lineRisePx: number;
}

export interface BookendPlan {
	format: BookendFormat;
	open: OpenPlan | null;
	end: EndPlan | null;
	type: TypeSpec;
	totalAddedMs: number;
}

export interface PlanInput {
	/** Hook word count (null or 0 = no opening). */
	hookWords: number | null;
	/** Spoken length of the hook voice in ms; omitted = the hook holds a fixed slot. */
	voiceMs?: number | null;
	format: BookendFormat;
	endCard?: boolean;
	endHoldMs?: number;
}

/** Without a hook voice the hook holds a fixed V of 2500 ms (CR-LENSMITH-A011-3 spec 3). */
export const DEFAULT_HOOK_VOICE_MS = 2500;
/** End card hold after the last line lands. */
export const DEFAULT_END_HOLD_MS = 4000;

/** Curves: Ripple size (entrances), Ripple fade (exits), Settle camera (veil). */
export const CURVES = {
	rippleSize: [0.23, 1, 0.32, 1],
	rippleFade: [0.77, 0, 0.175, 1],
	settle: [0.4, 0, 0.2, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>;

const TYPE: Record<BookendFormat, TypeSpec> = {
	"16:9": {
		width: 1920,
		height: 1080,
		veil: true,
		veilOpacity: 0.8,
		hook: { size: 88, left: 160, box: 1240, raise: 40 },
		hookRisePx: 12,
		title: { size: 96, lockupPx: 74.4, left: 160 },
		install: { size: 44, gapAbove: 56 },
		address: { size: 36, gapAbove: 20, opacity: 0.7 },
		lineRisePx: 16,
	},
	"9:16": {
		width: 1080,
		height: 1920,
		veil: false,
		veilOpacity: 0.8,
		hook: { size: 72, left: 76, box: 928, bottom: 600 },
		hookRisePx: 12,
		title: { size: 72, lockupPx: 55.8, left: 76, bottom: 603 },
		install: { size: 36, gapAbove: 0, top: 1344 },
		address: { size: 32, gapAbove: 16, opacity: 0.7 },
		lineRisePx: 16,
	},
};

export function planBookend(input: PlanInput): BookendPlan {
	const type = TYPE[input.format];
	let open: OpenPlan | null = null;
	if (input.hookWords && input.hookWords > 0) {
		const v = Math.max(0, Math.round(input.voiceMs ?? DEFAULT_HOOK_VOICE_MS));
		open = {
			voiceMs: v,
			still: { start: 0, end: 200 },
			hookIn: { start: 200, end: 600 },
			voiceStartMs: 600,
			lift: { start: v + 1200, end: v + 1900 },
			hookOut: { start: v + 1500, end: v + 1900 },
			totalMs: v + 1900,
		};
	}
	let end: EndPlan | null = null;
	if (input.endCard !== false) {
		const hold = Math.max(0, Math.round(input.endHoldMs ?? DEFAULT_END_HOLD_MS));
		end = {
			veil: { start: 0, end: 700 },
			title: { start: 400, end: 800 },
			install: { start: 500, end: 900 },
			address: { start: 600, end: 1000 },
			holdMs: hold,
			totalMs: 1000 + hold,
		};
	}
	return {
		format: input.format,
		open,
		end,
		type,
		totalAddedMs: (open?.totalMs ?? 0) + (end?.totalMs ?? 0),
	};
}

/** CSS cubic-bezier(p1x, p1y, p2x, p2y) as a function of progress, same solver as the cards. */
export function cubicBezier(p1x: number, p1y: number, p2x: number, p2y: number) {
	const a = (a1: number, a2: number) => 1 - 3 * a2 + 3 * a1;
	const b = (a1: number, a2: number) => 3 * a2 - 6 * a1;
	const c = (a1: number) => 3 * a1;
	const calc = (t: number, a1: number, a2: number) => ((a(a1, a2) * t + b(a1, a2)) * t + c(a1)) * t;
	const slope = (t: number, a1: number, a2: number) =>
		3 * a(a1, a2) * t * t + 2 * b(a1, a2) * t + c(a1);
	return (x: number): number => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let t = x;
		for (let i = 0; i < 8; i++) {
			const s = slope(t, p1x, p2x);
			if (Math.abs(s) < 1e-6) break;
			t -= (calc(t, p1x, p2x) - x) / s;
		}
		return calc(t, p1y, p2y);
	};
}

const EASE = {
	rippleSize: cubicBezier(...CURVES.rippleSize),
	rippleFade: cubicBezier(...CURVES.rippleFade),
	settle: cubicBezier(...CURVES.settle),
};

function progress(t: number, span: Span, ease: (x: number) => number): number {
	const d = span.end - span.start;
	if (d <= 0) return t >= span.end ? 1 : 0;
	return ease(Math.min(1, Math.max(0, (t - span.start) / d)));
}

export interface LayerState {
	opacity: number;
	dy: number;
}

export interface FrameState {
	veil: number;
	hook?: LayerState;
	title?: LayerState;
	install?: LayerState;
	address?: LayerState;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** What the frame at `tMs` of the opening or the end card shows. Pure. */
export function frameState(plan: BookendPlan, phase: "open" | "end", tMs: number): FrameState {
	const ty = plan.type;
	if (phase === "open") {
		const o = plan.open;
		if (!o) throw new Error("plan has no opening");
		const veil = ty.veil ? ty.veilOpacity * (1 - progress(tMs, o.lift, EASE.settle)) : 0;
		const kin = progress(tMs, o.hookIn, EASE.rippleSize);
		const kout = progress(tMs, o.hookOut, EASE.rippleFade);
		return {
			veil: r3(veil),
			hook: {
				opacity: r3(kin * (1 - kout)),
				dy: r3(ty.hookRisePx * (1 - kin) - ty.hookRisePx * kout),
			},
		};
	}
	const e = plan.end;
	if (!e) throw new Error("plan has no end card");
	const veil = ty.veil ? ty.veilOpacity * progress(tMs, e.veil, EASE.settle) : 0;
	const line = (span: Span, scale = 1): LayerState => {
		const k = progress(tMs, span, EASE.rippleSize);
		return { opacity: r3(k * scale), dy: r3(ty.lineRisePx * (1 - k)) };
	};
	return {
		veil: r3(veil),
		title: line(e.title),
		install: line(e.install),
		address: line(e.address, ty.address.opacity),
	};
}

/** Frame count of a segment at `fps` (frame-exact, rounded). */
export function frameCount(ms: number, fps: number): number {
	return Math.round((ms * fps) / 1000);
}

/** Picks the format from the input size: portrait = 9:16, anything else = 16:9. */
export function formatFromSize(width: number, height: number): BookendFormat {
	return height > width ? "9:16" : "16:9";
}

export function parseFormat(value: string | undefined): BookendFormat | undefined {
	if (value === undefined) return undefined;
	if (value === "16:9" || value === "9:16") return value;
	throw new Error(`--format must be 16:9 or 9:16 (got '${value}')`);
}

export const END_CARD_COPY = {
	title: "Made with",
	install: "npm install -g lensmith-director",
	address: "github.com/ynetplus/lensmith",
} as const;

const PAPER = "#F4F3EF";
const IRON = "#121417";
const INK = "#1A1D21";

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export interface PageInput {
	plan: BookendPlan;
	/** Render size (the input film's size). The card spec is drawn at 1920 or 1080 wide and scaled. */
	width: number;
	height: number;
	fontDataUrl: string;
	lockupSvg: string;
	hookText?: string;
}

/**
 * The film-size page the renderer screenshots. CSS values are the cards' own; the
 * background frame and the per-frame state are set by `window.__bookend.set`.
 */
export function buildBookendPage(p: PageInput): string {
	const ty = p.plan.type;
	const scale = p.width / ty.width;
	const lockup = p.lockupSvg.replace("<svg ", '<svg class="lockup" ');
	const hook = p.hookText ? escapeHtml(p.hookText) : "";
	const wide = p.plan.format === "16:9";
	const hookCss = wide
		? `.hook{left:${ty.hook.left}px;top:0;height:${ty.height}px;width:${ty.hook.box}px;display:flex;align-items:center}
.hook>div{position:relative;top:${-(ty.hook.raise ?? 0)}px}`
		: `.hook{left:${ty.hook.left}px;width:${ty.hook.box}px;bottom:${ty.height - (ty.hook.bottom ?? 0)}px}`;
	const endCss = wide
		? `.block{left:${ty.title.left}px;top:0;height:${ty.height}px;width:1600px;display:flex;flex-direction:column;justify-content:center}
.install{margin-top:${ty.install.gapAbove}px}`
		: `.ttl-slot{position:absolute;left:${ty.title.left}px;width:928px;bottom:${ty.height - (ty.title.bottom ?? 0)}px}
.lines{position:absolute;left:${ty.title.left}px;width:928px;top:${ty.install.top ?? 0}px}`;
	return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Bricolage Grotesque";font-weight:200 800;src:url(${p.fontDataUrl}) format("truetype")}
html,body{margin:0;background:${IRON};overflow:hidden}
.canvas{position:absolute;left:0;top:0;width:${ty.width}px;height:${ty.height}px;transform:scale(${scale});transform-origin:0 0;color:var(--fg,${PAPER})}
.bg{position:absolute;left:0;top:0;width:${ty.width}px;height:${ty.height}px}
.veil{position:absolute;inset:0;background:${IRON};opacity:0}
.disp{font-family:"Bricolage Grotesque",sans-serif;font-weight:600;letter-spacing:-0.02em;line-height:1.1}
.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.hook{position:absolute;font-size:${ty.hook.size}px;opacity:0}
${hookCss}
.block{position:absolute}
.l{opacity:0}
.title{font-size:${ty.title.size}px;white-space:nowrap}
.lockup{display:inline-block;height:${ty.title.lockupPx}px;width:auto;vertical-align:baseline;margin-left:0.22em}
.install{font-weight:500;font-size:${ty.install.size}px;line-height:1.3}
.url{font-weight:400;font-size:${ty.address.size}px;line-height:1.3;margin-top:${ty.address.gapAbove}px}
${endCss}
</style></head><body>
<div class="canvas" id="cv">
<img class="bg" id="bg" alt="">
<div class="veil" id="veil"></div>
<div class="hook disp" id="hookBox"><div id="hook">${hook}</div></div>
${
	wide
		? `<div class="block"><div class="l title disp" id="title">${END_CARD_COPY.title} ${lockup}</div><div class="l install mono" id="install">${END_CARD_COPY.install}</div><div class="l url mono" id="address">${END_CARD_COPY.address}</div></div>`
		: `<div class="ttl-slot"><div class="l title disp" id="title">${END_CARD_COPY.title} ${lockup}</div></div><div class="lines"><div class="l install mono" id="install">${END_CARD_COPY.install}</div><div class="l url mono" id="address">${END_CARD_COPY.address}</div></div>`
}
</div>
<script>
window.__bookend = {
  setBackground: function (src) {
    return new Promise(function (res) {
      var img = document.getElementById("bg");
      img.onload = function () {
        if (${wide ? "false" : "true"}) {
          var c = document.createElement("canvas"); c.width = 64; c.height = 64;
          var x = c.getContext("2d"); x.drawImage(img, 0, img.naturalHeight * 0.13, img.naturalWidth, img.naturalHeight * 0.18, 0, 0, 64, 64);
          var d = x.getImageData(0, 0, 64, 64).data, s = 0;
          for (var i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          document.getElementById("cv").style.setProperty("--fg", s / (d.length / 4) > 128 ? "${INK}" : "${PAPER}");
        }
        res(true);
      };
      img.src = src;
    });
  },
  set: function (st) {
    document.getElementById("veil").style.opacity = String(st.veil);
    ["hook", "title", "install", "address"].forEach(function (k) {
      var el = document.getElementById(k === "hook" ? "hookBox" : k);
      var v = st[k];
      if (!el) return;
      el.style.opacity = v ? String(v.opacity) : "0";
      el.style.transform = v ? "translateY(" + v.dy + "px)" : "none";
    });
  }
};
</script></body></html>`;
}

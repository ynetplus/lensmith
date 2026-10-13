import { describe, expect, it } from "vitest";
import {
	buildBookendPage,
	CURVES,
	canvasFor,
	cubicBezier,
	DEFAULT_HOOK_VOICE_MS,
	END_CARD_COPY,
	formatFromSize,
	frameCount,
	frameState,
	parseFormat,
	parseGround,
	planBookend,
} from "../src/lib/bookend.js";

describe("planBookend: the open card (Veil)", () => {
	const plan = planBookend({ hookWords: 9, voiceMs: 2600, format: "16:9" });
	const o = plan.open;

	it("has every timing of the card spec, in ms", () => {
		expect(o).not.toBeNull();
		expect(o?.still).toEqual({ start: 0, end: 200 });
		expect(o?.hookIn).toEqual({ start: 200, end: 600 });
		expect(o?.voiceStartMs).toBe(600);
		expect(o?.lift).toEqual({ start: 2600 + 1200, end: 2600 + 1900 });
		expect(o?.hookOut).toEqual({ start: 2600 + 1500, end: 2600 + 1900 });
		expect(o?.totalMs).toBe(4500);
	});

	it("matches the card's lengths for 12 and 15 word hooks", () => {
		expect(planBookend({ hookWords: 12, voiceMs: 3300, format: "16:9" }).open?.totalMs).toBe(5200);
		expect(planBookend({ hookWords: 15, voiceMs: 4100, format: "16:9" }).open?.totalMs).toBe(6000);
	});

	it("holds a fixed V without a hook voice", () => {
		const p = planBookend({ hookWords: 9, format: "16:9" });
		expect(p.open?.voiceMs).toBe(DEFAULT_HOOK_VOICE_MS);
		expect(p.open?.totalMs).toBe(DEFAULT_HOOK_VOICE_MS + 1900);
	});

	it("has no opening without a hook", () => {
		expect(planBookend({ hookWords: null, format: "16:9" }).open).toBeNull();
		expect(planBookend({ hookWords: 0, format: "16:9" }).open).toBeNull();
	});
});

describe("planBookend: the end card (Veil down)", () => {
	const plan = planBookend({ hookWords: null, format: "16:9" });
	const e = plan.end;

	it("has every timing of the card spec, in ms", () => {
		expect(e?.veil).toEqual({ start: 0, end: 700 });
		expect(e?.title).toEqual({ start: 400, end: 800 });
		expect(e?.install).toEqual({ start: 500, end: 900 });
		expect(e?.address).toEqual({ start: 600, end: 1000 });
		expect(e?.holdMs).toBe(4000);
		expect(e?.totalMs).toBe(5000);
		expect(plan.totalAddedMs).toBe(5000);
	});

	it("honours --no-end-card and a longer hold", () => {
		expect(planBookend({ hookWords: 3, format: "16:9", endCard: false }).end).toBeNull();
		expect(planBookend({ hookWords: null, format: "16:9", endHoldMs: 15000 }).end?.totalMs).toBe(
			16000,
		);
	});

	it("adds opening + end card", () => {
		expect(planBookend({ hookWords: 9, voiceMs: 2600, format: "9:16" }).totalAddedMs).toBe(9500);
	});
});

describe("type per format", () => {
	it("16:9: veil 0.80, hook 88 at x 160 in 1240, title 96 + lockup 74.4, install 44, address 36", () => {
		const t = planBookend({ hookWords: 1, format: "16:9" }).type;
		expect([t.width, t.height, t.veil, t.veilOpacity]).toEqual([1920, 1080, true, 0.8]);
		expect(t.hook).toEqual({ size: 88, left: 160, box: 1240, raise: 40 });
		expect(t.title).toMatchObject({ size: 96, lockupPx: 74.4, left: 160 });
		expect(t.install).toMatchObject({ size: 44, gapAbove: 56 });
		expect(t.address).toEqual({ size: 36, gapAbove: 20, opacity: 0.7 });
	});

	it("9:16: no veil, hook 72 at x 76 in 928 ending at y 600, install 36 at y 1344, address 32", () => {
		const t = planBookend({ hookWords: 1, format: "9:16" }).type;
		expect([t.width, t.height, t.veil]).toEqual([1080, 1920, false]);
		expect(t.hook).toEqual({ size: 72, left: 76, box: 928, bottom: 600 });
		expect(t.title).toMatchObject({ size: 72, lockupPx: 55.8, left: 76, bottom: 603 });
		expect(t.install).toMatchObject({ size: 36, top: 1344 });
		expect(t.address).toEqual({ size: 32, gapAbove: 16, opacity: 0.7 });
	});
});

describe("frameState", () => {
	const plan = planBookend({ hookWords: 9, voiceMs: 2600, format: "16:9" });

	it("open: veiled from frame 0, hook absent, then landed by 600, lifted at V + 1900", () => {
		expect(frameState(plan, "open", 0)).toEqual({ veil: 0.8, hook: { opacity: 0, dy: 12 } });
		expect(frameState(plan, "open", 1000)).toEqual({ veil: 0.8, hook: { opacity: 1, dy: 0 } });
		const mid = frameState(plan, "open", 2600 + 1550);
		expect(mid.veil).toBeGreaterThan(0);
		expect(mid.veil).toBeLessThan(0.8);
		expect(frameState(plan, "open", 4500)).toEqual({ veil: 0, hook: { opacity: 0, dy: -12 } });
	});

	it("end: veil down to 0.80 by 700, lines staggered, address at 70 percent", () => {
		expect(frameState(plan, "end", 0).veil).toBe(0);
		expect(frameState(plan, "end", 700).veil).toBe(0.8);
		const s450 = frameState(plan, "end", 450);
		expect(s450.title?.opacity).toBeGreaterThan(0);
		expect(s450.install?.opacity).toBe(0);
		const landed = frameState(plan, "end", 1000);
		expect(landed.title).toEqual({ opacity: 1, dy: 0 });
		expect(landed.install).toEqual({ opacity: 1, dy: 0 });
		expect(landed.address).toEqual({ opacity: 0.7, dy: 0 });
		expect(frameState(plan, "end", 4999)).toEqual(landed);
	});

	it("9:16 draws no veil", () => {
		const tall = planBookend({ hookWords: 9, format: "9:16" });
		expect(frameState(tall, "open", 0).veil).toBe(0);
		expect(frameState(tall, "end", 3000).veil).toBe(0);
	});
});

describe("helpers", () => {
	it("cubicBezier hits the ends and is monotonic for the Settle curve", () => {
		const settle = cubicBezier(...CURVES.settle);
		expect(settle(0)).toBe(0);
		expect(settle(1)).toBe(1);
		expect(settle(0.5)).toBeGreaterThan(settle(0.25));
	});

	it("frameCount, formatFromSize, parseFormat", () => {
		expect(frameCount(5000, 60)).toBe(300);
		expect(frameCount(4500, 30)).toBe(135);
		expect(formatFromSize(1920, 1080)).toBe("16:9");
		expect(formatFromSize(1080, 1920)).toBe("9:16");
		expect(parseFormat(undefined)).toBeUndefined();
		expect(parseFormat("9:16")).toBe("9:16");
		expect(() => parseFormat("4:3")).toThrow(/16:9 or 9:16/);
	});

	it("the page carries the copy, the escaped hook and no em dash", () => {
		const html = buildBookendPage({
			plan: planBookend({ hookWords: 3, format: "16:9" }),
			width: 1920,
			height: 1080,
			fontDataUrl: "data:font/ttf;base64,AAAA",
			lockupSvg: '<svg viewBox="0 0 1 1"></svg>',
			hookText: "Is <this> big?",
		});
		expect(html).toContain("Is &lt;this&gt; big?");
		expect(html).toContain(END_CARD_COPY.install);
		expect(html).toContain(END_CARD_COPY.address);
		expect(html).toContain('<svg class="lockup"');
		expect(html).not.toMatch(/[‒-―]/);
	});
});

describe("canvasFor (BF-22)", () => {
	it("16:9 keeps the input size and the film fills the canvas", () => {
		const c = canvasFor("16:9", { width: 1920, height: 1080 });
		expect([c.width, c.height]).toEqual([1920, 1080]);
		expect(c.tile).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
		expect(canvasFor("16:9", { width: 1280, height: 720 }).tile).toEqual({
			x: 0,
			y: 0,
			w: 1280,
			h: 720,
		});
	});

	it("9:16 is 1080x1920 whatever the input size, film tile 1080 wide and centred", () => {
		for (const input of [
			{ width: 1920, height: 1080 },
			{ width: 1280, height: 720 },
			{ width: 3840, height: 2160 },
		]) {
			const c = canvasFor("9:16", input);
			expect([c.width, c.height]).toEqual([1080, 1920]);
			expect(c.tile).toEqual({ x: 0, y: 656, w: 1080, h: 608 });
		}
	});

	it("9:16 tile height follows the input aspect, even, centred", () => {
		const c = canvasFor("9:16", { width: 1440, height: 1080 });
		expect(c.tile).toEqual({ x: 0, y: 555, w: 1080, h: 810 });
		expect(c.tile.y * 2 + c.tile.h).toBe(1920);
		expect(canvasFor("9:16", { width: 1080, height: 1920 }).tile).toEqual({
			x: 0,
			y: 0,
			w: 1080,
			h: 1920,
		});
	});

	it("9:16 fits a film taller than the frame by height", () => {
		const c = canvasFor("9:16", { width: 1000, height: 2000 });
		expect(c.tile).toEqual({ x: 60, y: 0, w: 960, h: 1920 });
	});

	it("ground paper by default (ink type), iron on request (paper type)", () => {
		expect(canvasFor("9:16", { width: 1920, height: 1080 })).toMatchObject({
			ground: "#F4F3EF",
			fg: "#1A1D21",
		});
		expect(canvasFor("9:16", { width: 1920, height: 1080 }, "iron")).toMatchObject({
			ground: "#121417",
			fg: "#F4F3EF",
		});
		expect(parseGround(undefined)).toBe("paper");
		expect(() => parseGround("blue")).toThrow(/paper or iron/);
	});

	it("the 9:16 page draws the film in its tile on the ground", () => {
		const plan = planBookend({ hookWords: 3, format: "9:16" });
		const canvas = canvasFor("9:16", { width: 1920, height: 1080 });
		const html = buildBookendPage({
			plan,
			width: canvas.width,
			height: canvas.height,
			canvas,
			fontDataUrl: "data:font/ttf;base64,AAAA",
			lockupSvg: '<svg viewBox="0 0 1 1"></svg>',
			hookText: "Hook",
		});
		expect(html).toContain(".bg{left:0px;top:656px;width:1080px;height:608px}");
		expect(html).toContain("transform:scale(1)");
		expect(html).toContain("--fg:#1A1D21");
	});
});
